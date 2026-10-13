import { type OpenCodeCredential, readOpenCodeEntry } from "./auth.js";

/**
 * OpenCode v2 keeps credentials in the server's credential store and exposes
 * them to plugins through the client API (`client.credential.list()`). The
 * legacy `auth.json` file is no longer maintained by v2, so entries there go
 * stale after a key rotation. The v2 store is consulted first and `auth.json`
 * remains a fallback for v1 hosts and offline setups.
 */
export type V2CredentialEntry = Readonly<{
	id: string;
	integrationID: string;
	label?: string;
	active: boolean;
	value?: unknown;
}>;

export type V2CredentialClient = Readonly<{
	credential: Readonly<{
		list: () => Promise<readonly V2CredentialEntry[]>;
	}>;
}>;

export type OpenCodeEntryReader = (
	entry: string,
) => Promise<OpenCodeCredential | undefined>;

export interface V2CredentialSourceOptions {
	readonly client?: V2CredentialClient;
	/** How long a credential listing stays cached. Defaults to 60s. */
	readonly ttlMs?: number;
	/** Reader used when the v2 store has no match. Defaults to auth.json. */
	readonly fallback?: OpenCodeEntryReader;
	readonly now?: () => number;
}

interface ListCache {
	readonly entries: readonly V2CredentialEntry[];
	readonly fetchedAt: number;
}

const DEFAULT_TTL_MS = 60_000;

export function createV2OpenCodeCredentialReader(
	options: V2CredentialSourceOptions = {},
): OpenCodeEntryReader {
	const fallback = options.fallback ?? readOpenCodeEntry;
	const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
	const now = options.now ?? (() => Date.now());
	let cache: ListCache | undefined;
	let inFlight: Promise<readonly V2CredentialEntry[]> | undefined;

	const listCredentials = async (): Promise<readonly V2CredentialEntry[]> => {
		if (cache && now() - cache.fetchedAt < ttlMs) return cache.entries;
		if (!inFlight) {
			inFlight = (async () => {
				const entries = await options.client!.credential.list();
				cache = { entries, fetchedAt: now() };
				return entries;
			})().finally(() => {
				inFlight = undefined;
			});
		}
		return inFlight;
	};

	return async (entry: string): Promise<OpenCodeCredential | undefined> => {
		if (options.client) {
			try {
				const entries = await listCredentials();
				const credential = entryFromV2List(entries, entry);
				if (credential) return credential;
			} catch {
				// v2 store unavailable (remote server, older host) — fall back.
			}
		}
		return fallback(entry);
	};
}

function entryFromV2List(
	entries: readonly V2CredentialEntry[],
	entryName: string,
): OpenCodeCredential | undefined {
	const matches = entries.filter(
		(candidate) => candidate.integrationID === entryName,
	);
	const credential =
		matches.find((candidate) => candidate.active) ?? matches[0];
	if (!credential) return undefined;
	return v2ValueToCredential(credential.value);
}

function v2ValueToCredential(
	value: unknown,
): OpenCodeCredential | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Readonly<Record<string, unknown>>;
	const secret = readSecret(record);
	if (!secret) return undefined;
	const metadata: Record<string, string> = {};
	if (typeof record.type === "string") metadata.type = record.type;
	if (typeof record.expires === "number")
		metadata.expires = String(record.expires);
	return Object.freeze({
		secret,
		metadata: Object.freeze(metadata),
	});
}

function readSecret(record: Readonly<Record<string, unknown>>): string | undefined {
	const candidates =
		record.type === "oauth"
			? ["access", "accessToken", "token", "key"]
			: ["key", "apiKey", "api_key", "token", "access", "accessToken"];
	for (const field of candidates) {
		const value = record[field];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}
