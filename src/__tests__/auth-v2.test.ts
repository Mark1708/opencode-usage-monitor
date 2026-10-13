/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
	createV2OpenCodeCredentialReader,
	type V2CredentialClient,
	type V2CredentialEntry,
} from "../auth-v2.js";
import type { OpenCodeCredential } from "../auth.js";

const ACTIVE_KEY = "v2-active-credential-key";
const INACTIVE_KEY = "v2-inactive-credential-key";
const FALLBACK_KEY = "legacy-auth-json-key";

function entry(partial: Partial<V2CredentialEntry>): V2CredentialEntry {
	return {
		id: "cred_test",
		integrationID: "zai-coding-plan",
		active: true,
		...partial,
	};
}

function clientWith(entries: readonly V2CredentialEntry[]): V2CredentialClient {
	return {
		credential: {
			list: async () => entries,
		},
	};
}

const noFallback = async () => undefined;

describe("createV2OpenCodeCredentialReader", () => {
	test("prefers the active credential from the v2 store", async () => {
		const reader = createV2OpenCodeCredentialReader({
			client: clientWith([
				entry({
					id: "cred_inactive",
					active: false,
					value: { type: "key", key: INACTIVE_KEY },
				}),
				entry({
					id: "cred_active",
					active: true,
					value: { type: "key", key: ACTIVE_KEY },
				}),
			]),
			fallback: noFallback,
		});

		const credential = await reader("zai-coding-plan");
		expect(credential?.secret).toBe(ACTIVE_KEY);
		expect(credential?.metadata?.type).toBe("key");
	});

	test("falls back to the first matching entry when none is active", async () => {
		const reader = createV2OpenCodeCredentialReader({
			client: clientWith([
				entry({ id: "cred_only", active: false, value: { type: "key", key: INACTIVE_KEY } }),
			]),
			fallback: noFallback,
		});

		const credential = await reader("zai-coding-plan");
		expect(credential?.secret).toBe(INACTIVE_KEY);
	});

	test("falls back to auth.json when the v2 store has no match", async () => {
		const reader = createV2OpenCodeCredentialReader({
			client: clientWith([]),
			fallback: async () =>
				Object.freeze({ secret: FALLBACK_KEY, metadata: Object.freeze({ type: "api" }) }) as OpenCodeCredential,
		});

		const credential = await reader("zai-coding-plan");
		expect(credential?.secret).toBe(FALLBACK_KEY);
	});

	test("falls back when the v2 client errors", async () => {
		const failing: V2CredentialClient = {
			credential: {
				list: async () => {
					throw new Error("remote server unavailable");
				},
			},
		};
		const reader = createV2OpenCodeCredentialReader({
			client: failing,
			fallback: async () => Object.freeze({ secret: FALLBACK_KEY, metadata: Object.freeze({}) }),
		});

		const credential = await reader("zai-coding-plan");
		expect(credential?.secret).toBe(FALLBACK_KEY);
	});

	test("caches the credential listing within the ttl", async () => {
		let calls = 0;
		const entries = [entry({ value: { type: "key", key: ACTIVE_KEY } })];
		const counting: V2CredentialClient = {
			credential: {
				list: async () => {
					calls += 1;
					return [...entries];
				},
			},
		};
		const reader = createV2OpenCodeCredentialReader({
			client: counting,
			fallback: noFallback,
		});

		await reader("zai-coding-plan");
		await reader("zai-coding-plan");
		expect(calls).toBe(1);

		entries[0] = entry({ value: { type: "key", key: "rotated" } });
		const stale = await reader("zai-coding-plan");
		expect(stale?.secret).toBe(ACTIVE_KEY);
		expect(calls).toBe(1);
	});

	test("reads oauth access tokens from the v2 store", async () => {
		const reader = createV2OpenCodeCredentialReader({
			client: clientWith([
				entry({
					active: true,
					value: { type: "oauth", access: "oauth-access-token", expires: 1791900000000 },
				}),
			]),
			fallback: noFallback,
		});

		const credential = await reader("zai-coding-plan");
		expect(credential?.secret).toBe("oauth-access-token");
		expect(credential?.metadata?.type).toBe("oauth");
		expect(credential?.metadata?.expires).toBe("1791900000000");
	});
});
