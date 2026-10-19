/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { Credential, Integration } from "@opencode/plugin";

import {
	createV2OpenCodeCredentialReader,
	projectV2CredentialValue,
	type V2CredentialClient,
	type V2CredentialEntry,
} from "../auth-v2.js";

const ACTIVE_KEY = "v2-active-credential-key";
const INACTIVE_KEY = "v2-inactive-credential-key";
const INTEGRATION_ID = Integration.ID.make("zai-coding-plan");

function keyEntry(options: {
	readonly id?: string;
	readonly integrationID?: typeof INTEGRATION_ID;
	readonly active?: boolean;
	readonly key?: string;
	readonly metadata?: Readonly<Record<string, unknown>>;
} = {}): V2CredentialEntry {
	return {
		id: Credential.ID.make(options.id ?? "cred_test"),
		integrationID: options.integrationID ?? INTEGRATION_ID,
		label: "credential label must not be projected",
		active: options.active ?? true,
		value: {
			type: "key",
			key: options.key ?? ACTIVE_KEY,
			metadata: options.metadata,
		},
	};
}

function clientWith(entries: readonly V2CredentialEntry[]): V2CredentialClient {
	return {
		credential: {
			list: async () => [...entries],
		},
	};
}

function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: (value) => resolvePromise?.(value),
	};
}

describe("createV2OpenCodeCredentialReader", () => {
	test("selects only the active integration credential and never falls back to inactive", async () => {
		const active = createV2OpenCodeCredentialReader({
			client: clientWith([
				keyEntry({ id: "cred_inactive", active: false, key: INACTIVE_KEY }),
				keyEntry({ id: "cred_active", key: ACTIVE_KEY }),
			]),
		});
		const inactiveOnly = createV2OpenCodeCredentialReader({
			client: clientWith([
				keyEntry({ id: "cred_only", active: false, key: INACTIVE_KEY }),
			]),
		});

		expect(await active("zai-coding-plan")).toEqual({
			secret: ACTIVE_KEY,
			metadata: { type: "key" },
		});
		expect(await inactiveOnly("zai-coding-plan")).toBeUndefined();
		expect(await active("different-integration")).toBeUndefined();
	});

	test("projects OAuth accountID/accountId without refresh, label, or arbitrary metadata", async () => {
		for (const accountKey of ["accountID", "accountId"] as const) {
			const reader = createV2OpenCodeCredentialReader({
				client: clientWith([{
					id: Credential.ID.make(`cred_${accountKey}`),
					integrationID: INTEGRATION_ID,
					label: "private label",
					active: true,
					value: {
						type: "oauth",
						methodID: Integration.MethodID.make("oauth"),
						access: "oauth-access-token",
						refresh: "refresh-must-not-leak",
						expires: 1_791_900_000_000,
						metadata: {
							[accountKey]: "account-123",
							arbitrary: "must-not-leak",
						},
					},
				}]),
			});

			const credential = await reader("zai-coding-plan");
			expect(credential).toEqual({
				secret: "oauth-access-token",
				metadata: {
					type: "oauth",
					expires: "1791900000000",
					accountId: "account-123",
				},
			});
			expect(JSON.stringify(credential)).not.toContain("refresh-must-not-leak");
			expect(JSON.stringify(credential)).not.toContain("private label");
			expect(JSON.stringify(credential)).not.toContain("arbitrary");
		}
	});

	test("rejects external and malformed values", () => {
		expect(projectV2CredentialValue({
			type: "external",
			methodID: "external",
			metadata: {},
		})).toBeUndefined();
		expect(projectV2CredentialValue({ type: "key", key: "" })).toBeUndefined();
		expect(projectV2CredentialValue({ type: "oauth", access: "token", expires: "later" })).toBeUndefined();
		expect(projectV2CredentialValue(null)).toBeUndefined();
	});

	test("coalesces concurrent reads and caches normalized projections within the TTL", async () => {
		let calls = 0;
		let now = 100;
		const pending = deferred<readonly V2CredentialEntry[]>();
		const client: V2CredentialClient = {
			credential: {
				list: async () => {
					calls += 1;
					return pending.promise;
				},
			},
		};
		const reader = createV2OpenCodeCredentialReader({ client, now: () => now, ttlMs: 60_000 });

		const first = reader("zai-coding-plan");
		const second = reader("zai-coding-plan");
		expect(calls).toBe(1);
		pending.resolve([keyEntry()]);
		expect(await first).toEqual(await second);
		now += 1_000;
		expect((await reader("zai-coding-plan"))?.secret).toBe(ACTIVE_KEY);
		expect(calls).toBe(1);
	});

	test("invalidation detaches an old list so it cannot satisfy or cache a new resolve", async () => {
		const oldList = deferred<readonly V2CredentialEntry[]>();
		const newList = deferred<readonly V2CredentialEntry[]>();
		let calls = 0;
		const client: V2CredentialClient = {
			credential: {
				list: async () => {
					calls += 1;
					return calls === 1 ? oldList.promise : newList.promise;
				},
			},
		};
		const reader = createV2OpenCodeCredentialReader({ client });

		const staleRead = reader("zai-coding-plan");
		reader.invalidate();
		const currentRead = reader("zai-coding-plan");
		expect(calls).toBe(2);
		oldList.resolve([keyEntry({ key: "old-key" })]);
		expect(await staleRead).toBeUndefined();
		newList.resolve([keyEntry({ key: "new-key" })]);
		expect((await currentRead)?.secret).toBe("new-key");
		expect((await reader("zai-coding-plan"))?.secret).toBe("new-key");
		expect(calls).toBe(2);
	});
});
