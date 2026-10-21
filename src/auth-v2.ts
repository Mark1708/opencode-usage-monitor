import type { CredentialEntry } from "@opencode/client";
import type { Plugin } from "@opencode/plugin/tui";

import type { OpenCodeCredential } from "./auth.js";
import { asRecord } from "./providers/shared.js";

export type V2CredentialEntry = CredentialEntry;

export type V2CredentialClient = Readonly<{
	credential: Pick<Plugin.Context["client"]["credential"], "list">;
}>;

export interface V2OpenCodeCredentialReader {
	(entry: string): Promise<OpenCodeCredential | undefined>;
	invalidate(): void;
}

export type V2CredentialSourceOptions = Readonly<{
	client: V2CredentialClient;
	/** How long normalized credential projections stay cached. */
	ttlMs?: number;
	now?: () => number;
}>;

type ProjectionCache = Readonly<{
	generation: number;
	projections: ReadonlyMap<string, OpenCodeCredential>;
	fetchedAt: number;
}>;

type InFlightList = Readonly<{
	generation: number;
	promise: Promise<ReadonlyMap<string, OpenCodeCredential>>;
}>;

const DEFAULT_TTL_MS = 60_000;

export function createV2OpenCodeCredentialReader(
	options: V2CredentialSourceOptions,
): V2OpenCodeCredentialReader {
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const now = options.now ?? (() => Date.now());
	let generation = 1;
	let cache: ProjectionCache | undefined;
	let inFlight: InFlightList | undefined;

	const listProjections = (
		requestedGeneration: number,
	): Promise<ReadonlyMap<string, OpenCodeCredential>> => {
		if (
			cache?.generation === requestedGeneration &&
			now() - cache.fetchedAt < ttlMs
		) {
			return Promise.resolve(cache.projections);
		}
		if (inFlight?.generation === requestedGeneration) return inFlight.promise;

		const promise = (async () => {
			const entries = await options.client.credential.list();
			const projections = projectActiveCredentials(entries);
			if (generation === requestedGeneration) {
				cache = Object.freeze({
					generation: requestedGeneration,
					projections,
					fetchedAt: now(),
				});
			}
			return projections;
		})();
		const request = Object.freeze({ generation: requestedGeneration, promise });
		inFlight = request;
		const clear = (): void => {
			if (inFlight === request) inFlight = undefined;
		};
		void promise.then(clear, clear);
		return promise;
	};

	const reader = async (
		entry: string,
	): Promise<OpenCodeCredential | undefined> => {
		const requestedGeneration = generation;
		const projections = await listProjections(requestedGeneration);
		if (generation !== requestedGeneration) return undefined;
		return projections.get(entry);
	};

	return Object.freeze(Object.assign(reader, {
		invalidate(): void {
			generation += 1;
			cache = undefined;
			inFlight = undefined;
		},
	}));
}

function projectActiveCredentials(
	entries: readonly V2CredentialEntry[],
): ReadonlyMap<string, OpenCodeCredential> {
	const projections = new Map<string, OpenCodeCredential>();
	for (const entry of entries) {
		if (!entry.active || projections.has(entry.integrationID)) continue;
		const projection = projectV2CredentialValue(entry.value);
		if (projection) projections.set(entry.integrationID, projection);
	}
	return projections;
}

export function projectV2CredentialValue(
	value: unknown,
): OpenCodeCredential | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.type === "key") {
		if (!isNonEmptyString(record.key)) return undefined;
		return credentialProjection(record.key, { type: "key" });
	}
	if (record.type !== "oauth") return undefined;
	if (!isNonEmptyString(record.access)) return undefined;
	if (typeof record.expires !== "number" || !Number.isFinite(record.expires)) {
		return undefined;
	}
	const metadata: Record<string, string> = {
		type: "oauth",
		expires: String(record.expires),
	};
	const hostMetadata = asRecord(record.metadata);
	if (hostMetadata) {
		const accountId = isNonEmptyString(hostMetadata.accountID)
			? hostMetadata.accountID
			: isNonEmptyString(hostMetadata.accountId)
				? hostMetadata.accountId
				: undefined;
		if (accountId) metadata.accountId = accountId;
	}
	return credentialProjection(record.access, metadata);
}

function credentialProjection(
	secret: string,
	metadata: Readonly<Record<string, string>>,
): OpenCodeCredential {
	return Object.freeze({
		secret,
		metadata: Object.freeze({ ...metadata }),
	});
}


function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}
