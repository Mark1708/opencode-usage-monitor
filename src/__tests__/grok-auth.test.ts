/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { Credential, Integration } from "@opencode/plugin";
import { createGrokAuthPreparation } from "../grok-auth.js";
import { GrokAuthRpc } from "../grok-auth-rpc.js";
import { createV2OpenCodeCredentialReader } from "../auth-v2.js";
import { createCredentialResolver } from "../credentials.js";
import { createProviderCacheV2 } from "../provider-cache.js";
import { createRefreshCoordinator } from "../refresh.js";
import { parseUsageConfigV2 } from "../runtime-config.js";
import { mockJsonResponse, restoreFetch } from "./_helpers.js";

afterEach(restoreFetch);

const connection = { type: "credential", id: Credential.ID.make("cred_xai_a"), label: "xai", method: "oauth" } as const;
const oauth = (access: string, expires: number) => Credential.OAuth.make({
	type: "oauth", access, expires, refresh: "refresh-must-stay-in-host",
	methodID: Integration.MethodID.make("device"),
});

describe("Grok host-managed OAuth renewal", () => {
	test("recovers through the coordinator when host renewal emits credential.updated mid-refresh", async () => {
		const config = parseUsageConfigV2({ version: 2, providers: { grok: {} }, refresh: { mode: "manual" } });
		if (!config.ok) throw new Error("invalid config");
		let stored = oauth("expired", 1);
		let notify = () => {};
		let rotations = 0;
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			if (stored.expires <= Date.now()) {
				stored = oauth("renewed", Date.now() + 3_600_000);
				rotations++;
				notify();
			}
			return stored;
		} });
		const reader = createV2OpenCodeCredentialReader({
			client: { credential: { list: async () => [{ id: connection.id, integrationID: Integration.ID.make("xai"), label: "xai", active: true,
				value: { type: "oauth", access: stored.access, refresh: "refresh-must-stay-in-host", expires: stored.expires, methodID: stored.methodID },
			}] } }, prepareGrokCredential: auth.prepare,
		});
		const resolver = createCredentialResolver({ readOpenCodeEntry: reader, readEnv: () => undefined });
		const coordinator = createRefreshCoordinator({ providers: config.value.providers, policy: config.value.refresh, credentialResolver: resolver, cache: createProviderCacheV2() });
		let eventRefresh = Promise.resolve();
		notify = () => {
			reader.invalidate();
			coordinator.invalidateCredentials();
			eventRefresh = coordinator.refreshAll();
		};
		mockJsonResponse({ config: { creditUsagePercent: 7 } });
		try {
			await coordinator.refreshAll();
			await eventRefresh;
			expect(coordinator.getStates()[0]).toMatchObject({ status: "ready", snapshot: { windows: [{ percentage: 7 }] } });
			expect(rotations).toBe(1);
			// The next expiry can recover through the same path without a new login.
			stored = oauth("expired-again", 1);
			await coordinator.refreshAll();
			await eventRefresh;
			expect(coordinator.getStates()[0]?.status).toBe("ready");
			expect(rotations).toBe(2);
		} finally {
			coordinator.dispose();
			auth.dispose();
		}
	});
	test("delegates expired-token renewal to host resolve without returning credentials", async () => {
		let stored = oauth("expired-access", 1);
		let resolves = 0;
		const auth = createGrokAuthPreparation({
			active: async () => connection,
			resolve: async (selected) => {
				expect(selected.type === "credential" && selected.id).toBe(connection.id);
				resolves++;
				stored = oauth("renewed-access", Date.now() + 60_000);
				return stored;
			},
		});
		expect(await auth.prepare()).toBe("ready");
		expect(resolves).toBe(1);
		expect(stored.access).toBe("renewed-access");
		expect(JSON.stringify(await auth.prepare())).not.toContain("refresh-must-stay-in-host");
		auth.dispose();
	});
	test("coalesces concurrent preparation including multiple TUI callers", async () => {
		const pending = Promise.withResolvers<ReturnType<typeof oauth>>();
		let calls = 0;
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => { calls++; return pending.promise; } });
		const first = auth.prepare();
		const second = auth.prepare();
		expect(first).toBe(second);
		pending.resolve(oauth("fresh", Date.now() + 60_000));
		expect(await first).toBe("ready");
		expect(calls).toBe(1);
	});
	test("does not resolve missing, environment, or API-key connections", async () => {
		let calls = 0;
		for (const active of [undefined, { type: "env", name: "XAI_API_KEY" } as const, { ...connection, method: "key" as const }]) {
			const auth = createGrokAuthPreparation({ active: async () => active, resolve: async () => { calls++; return undefined; } });
			expect(await auth.prepare()).toBe("missing");
		}
		expect(calls).toBe(0);
	});
	test("does not use the old account after a switch during renewal", async () => {
		let selected = connection;
		const auth = createGrokAuthPreparation({ active: async () => selected, resolve: async () => {
			selected = { ...connection, id: Credential.ID.make("cred_xai_b") };
			return oauth("old-account-access", Date.now() + 60_000);
		} });
		expect(await auth.prepare()).toBe("missing");
	});
	test("returns a fixed failure status, not raw host errors, and permits retry", async () => {
		let fail = true;
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			if (fail) throw new Error("refresh-must-stay-in-host");
			return oauth("fresh", Date.now() + 60_000);
		} });
		expect(await auth.prepare()).toBe("failed");
		fail = false;
		expect(await auth.prepare()).toBe("ready");
	});
	test("does not report success if host returns an expired OAuth token", async () => {
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => oauth("expired", 1) });
		expect(await auth.prepare()).toBe("missing");
	});
	test("disposal prevents late results from becoming available", async () => {
		const pending = Promise.withResolvers<ReturnType<typeof oauth>>();
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: () => pending.promise });
		const result = auth.prepare();
		auth.dispose();
		pending.resolve(oauth("fresh", Date.now() + 60_000));
		expect(await result).toBe("missing");
		expect(await auth.prepare()).toBe("missing");
	});
	test("RPC declares status-only output and accepts no account or token input", () => {
		expect(GrokAuthRpc.methods.prepare.output).toEqual({ type: "string", enum: ["ready", "missing", "failed"] });
		expect(GrokAuthRpc.methods.prepare.input).toEqual({ type: "object", additionalProperties: false });
	});
	test("re-reads the host credential after renewal even within the projection TTL", async () => {
		let stored = oauth("initial", Date.now() + 60_000);
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			if (stored.expires <= Date.now()) stored = oauth("renewed", Date.now() + 60_000);
			return stored;
		} });
		const reader = createV2OpenCodeCredentialReader({
			client: { credential: { list: async () => [{ id: connection.id, integrationID: Integration.ID.make("xai"), label: "xai", active: true,
				value: { type: "oauth", access: stored.access, refresh: "refresh-must-stay-in-host", expires: stored.expires, methodID: stored.methodID },
			}] } },
			prepareGrokCredential: auth.prepare,
		});
		expect((await reader("xai"))?.secret).toBe("initial");
		stored = oauth("expired", 1);
		const renewed = await reader("xai");
		expect(renewed?.secret).toBe("renewed");
		expect(JSON.stringify(renewed)).not.toContain("refresh-must-stay-in-host");
	});
	test("disabled or unrelated providers never trigger Grok renewal", async () => {
		let calls = 0;
		const reader = createV2OpenCodeCredentialReader({ client: { credential: { list: async () => [] } }, prepareGrokCredential: async () => { calls++; return "ready"; } });
		await reader("openai");
		await reader("zai-coding-plan");
		expect(calls).toBe(0);
	});
	test("invalidation drops a late renewal result without listing credentials", async () => {
		const pending = Promise.withResolvers<unknown>();
		let lists = 0;
		const reader = createV2OpenCodeCredentialReader({ client: { credential: { list: async () => { lists++; return []; } } }, prepareGrokCredential: () => pending.promise });
		const result = reader("xai");
		reader.invalidate();
		pending.resolve("ready");
		expect(await result).toBeUndefined();
		expect(lists).toBe(0);
	});
	test("a host failure never falls back to a stale cached token", async () => {
		let lists = 0;
		const reader = createV2OpenCodeCredentialReader({ client: { credential: { list: async () => { lists++; return []; } } }, prepareGrokCredential: async () => "failed" });
		await expect(reader("xai")).rejects.toThrow("Unable to refresh Grok authorization through OpenCode");
		expect(lists).toBe(0);
	});
});
