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
import { grokProviderDefinition } from "../providers/grok.js";

afterEach(restoreFetch);

const connection = { type: "credential", id: Credential.ID.make("cred_xai_a"), label: "xai", method: "oauth" } as const;
const oauth = (access: string, expires: number) => Credential.OAuth.make({
	type: "oauth", access, expires, refresh: "refresh-must-stay-in-host",
	methodID: Integration.MethodID.make("device"),
});

describe("Grok host-managed OAuth renewal", () => {
	test.each([false, true])("classifies regional OAuth denial without returning HTML or secrets (wrapped: %s)", async (wrapped) => {
		const raw = new Error('xAI request failed (403): <!doctype html><p>This service is not available in your region.</p><script>private-access-must-not-leak</script>');
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			throw wrapped ? new Error("Authorization failed", { cause: raw }) : raw;
		} });
		expect(await auth.prepare()).toBe("region-blocked");
	});
	test("does not mislabel an arbitrary HTTP 403 as a regional denial", async () => {
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			throw new Error("xAI request failed (403): access denied private-access-must-not-leak");
		} });
		expect(await auth.prepare()).toBe("failed");
	});
	test("does not evaluate error getters or loop on cyclic causes", async () => {
		let getterCalls = 0;
		const error = Object.defineProperty({}, "message", { get() { getterCalls++; throw new Error("secret"); } });
		Object.assign(error, { cause: error });
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => { throw error; } });
		expect(await auth.prepare()).toBe("failed");
		expect(getterCalls).toBe(0);
	});
	test("renders the allowlisted region reason through RPC reader, resolver, and coordinator", async () => {
		const config = parseUsageConfigV2({ version: 2, providers: { grok: {} }, refresh: { mode: "manual" } });
		if (!config.ok) throw new Error("invalid config");
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			throw new Error("xAI request failed (403): <p>This service is not available in your region.</p><script>private-access-must-not-leak</script>");
		} });
		let lists = 0;
		const reader = createV2OpenCodeCredentialReader({ client: { credential: { list: async () => { lists++; return []; } } }, prepareGrokCredential: auth.prepare });
		const resolver = createCredentialResolver({ readOpenCodeEntry: reader, readEnv: () => undefined });
		const coordinator = createRefreshCoordinator({ providers: config.value.providers, policy: config.value.refresh, credentialResolver: resolver, cache: createProviderCacheV2() });
		try {
			await coordinator.refreshAll();
			expect(coordinator.getStates()[0]).toMatchObject({ status: "error", message: "xAI unavailable in your region" });
			expect(coordinator.getStates()[0]?.nextDueAt).toBeUndefined();
			expect(JSON.stringify(coordinator.getStates())).not.toContain("private-access-must-not-leak");
			expect(JSON.stringify(coordinator.getStates())).not.toContain("<script>");
			expect(lists).toBe(0);
		} finally {
			coordinator.dispose();
			auth.dispose();
		}
	});
	test("never forwards a reason or raw message from an arbitrary source error", async () => {
		const resolver = createCredentialResolver({ readOpenCodeEntry: async () => {
			throw Object.assign(new Error("private-access-must-not-leak"), { reason: "region-blocked" });
		}, readEnv: () => undefined });
		try {
			const result = await resolver.resolve(grokProviderDefinition.registration);
			expect(result).toMatchObject({ ok: false, kind: "source" });
			expect(result).not.toHaveProperty("reason");
			expect(JSON.stringify(result)).not.toContain("private-access-must-not-leak");
		} finally { resolver.dispose(); }
	});
	test.each(["region", "network"])("automatically recovers from %s OAuth failure after VPN is enabled", async (failure) => {
		const config = parseUsageConfigV2({ version: 2, providers: { grok: {} } });
		if (!config.ok) throw new Error("invalid config");
		let online = false;
		let resolves = 0;
		let lists = 0;
		let now = 1_000;
		let timer: { callback: () => void; dueAt: number } | undefined;
		const stored = oauth("recovered-access", Date.now() + 3_600_000);
		const auth = createGrokAuthPreparation({ active: async () => connection, resolve: async () => {
			resolves++;
			if (!online) throw new Error(failure === "region"
				? "This service is not available in your region." : "network unavailable");
			return stored;
		} });
		const reader = createV2OpenCodeCredentialReader({
			client: { credential: { list: async () => {
				lists++;
				return [{ id: connection.id, integrationID: Integration.ID.make("xai"), label: "xai", active: true,
					value: { type: "oauth", access: stored.access, refresh: stored.refresh, expires: stored.expires, methodID: stored.methodID },
				}];
			} } }, prepareGrokCredential: auth.prepare,
		});
		const coordinator = createRefreshCoordinator({
			providers: config.value.providers, policy: config.value.refresh,
			credentialResolver: createCredentialResolver({ readOpenCodeEntry: reader, readEnv: () => undefined }),
			cache: createProviderCacheV2(), clock: { now: () => now },
			timers: {
				setTimeout(callback, delayMs) { timer = { callback, dueAt: now + delayMs }; return timer; },
				clearTimeout(handle) { if (timer === handle) timer = undefined; },
			},
		});
		const settle = async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); };
		const advance = async (milliseconds: number) => {
			now += milliseconds;
			if (timer && timer.dueAt <= now) {
				const callback = timer.callback;
				timer = undefined;
				callback();
			}
			await settle();
		};
		mockJsonResponse({ config: { creditUsagePercent: 7 } });
		try {
			await settle();
			expect(coordinator.getStates()[0]).toMatchObject({ status: "error", nextDueAt: 61_000 });
			expect(lists).toBe(0);
			await advance(59_999);
			expect(resolves).toBe(1);
			await advance(1);
			expect(resolves).toBe(2);
			expect(coordinator.getStates()[0]).toMatchObject({ status: "error", nextDueAt: 121_000 });
			online = true;
			await advance(60_000);
			expect(resolves).toBe(3);
			expect(lists).toBe(1);
			expect(coordinator.getStates()[0]).toMatchObject({
				status: "ready", nextDueAt: now + config.value.refresh.interval_ms,
				snapshot: { windows: [{ percentage: 7 }] },
			});
			expect(coordinator.getStates()[0]?.message).toBeUndefined();
		} finally {
			coordinator.dispose();
			auth.dispose();
		}
		expect(timer).toBeUndefined();
		await advance(300_000);
		expect(resolves).toBe(3);
	});
	test.each([
		{ failure: "rpc", mode: "automatic" },
		{ failure: "credential-list", mode: "automatic" },
		{ failure: "rpc", mode: "manual" },
		{ failure: "credential-list", mode: "manual" },
	] as const)("handles startup $failure failure in $mode mode", async ({ failure, mode }) => {
		const config = parseUsageConfigV2({ version: 2, providers: { grok: {} }, refresh: { mode } });
		if (!config.ok) throw new Error("invalid config");
		let available = false;
		let preparations = 0;
		let lists = 0;
		let now = 1_000;
		let timer: { callback: () => void; dueAt: number } | undefined;
		const stored = oauth("startup-access", Date.now() + 3_600_000);
		const reader = createV2OpenCodeCredentialReader({
			prepareGrokCredential: async () => {
				preparations++;
				if (!available && failure === "rpc") throw new Error("startup RPC unavailable private-must-not-leak");
				return "ready";
			},
			client: { credential: { list: async () => {
				lists++;
				if (!available && failure === "credential-list") throw new Error("startup list unavailable private-must-not-leak");
				return [{ id: connection.id, integrationID: Integration.ID.make("xai"), label: "xai", active: true,
					value: { type: "oauth", access: stored.access, expires: stored.expires, refresh: stored.refresh, methodID: stored.methodID },
				}];
			} } },
		});
		const coordinator = createRefreshCoordinator({
			providers: config.value.providers, policy: config.value.refresh,
			credentialResolver: createCredentialResolver({ readOpenCodeEntry: reader, readEnv: () => undefined }),
			cache: createProviderCacheV2(), clock: { now: () => now },
			timers: {
				setTimeout(callback, delayMs) { timer = { callback, dueAt: now + delayMs }; return timer; },
				clearTimeout(handle) { if (timer === handle) timer = undefined; },
			},
		});
		const settle = async () => { for (let turn = 0; turn < 50; turn++) await Promise.resolve(); };
		const advance = async (milliseconds: number) => {
			now += milliseconds;
			if (timer && timer.dueAt <= now) {
				const callback = timer.callback;
				timer = undefined;
				callback();
			}
			await settle();
		};
		mockJsonResponse({ config: { creditUsagePercent: 7 } });
		try {
			// TUI startup also requests refreshAll while constructor bootstrap is pending.
			await coordinator.refreshAll();
			await settle();
			expect(preparations).toBe(1);
			expect(coordinator.getStates()[0]).toMatchObject({
				status: "error", message: "Credential source is unavailable",
			});
			expect(coordinator.getStates()[0]?.nextDueAt).toBe(mode === "automatic" ? 61_000 : undefined);
			expect(JSON.stringify(coordinator.getStates())).not.toContain("private-must-not-leak");
			expect(lists).toBe(failure === "rpc" ? 0 : 2);
			available = true;
			await advance(59_999);
			expect(preparations).toBe(1);
			await advance(1);
			if (mode === "manual") {
				expect(timer).toBeUndefined();
				expect(preparations).toBe(1);
				expect(coordinator.getStates()[0]?.status).toBe("error");
				await coordinator.refreshAll();
			}
			expect(preparations).toBe(2);
			expect(coordinator.getStates()[0]).toMatchObject({
				status: "ready", snapshot: { windows: [{ percentage: 7 }] },
			});
			expect(coordinator.getStates()[0]?.message).toBeUndefined();
			expect(coordinator.getStates()[0]?.nextDueAt).toBe(mode === "automatic" ? now + config.value.refresh.interval_ms : undefined);
		} finally {
			coordinator.dispose();
		}
		expect(timer).toBeUndefined();
		await advance(300_000);
		expect(preparations).toBe(2);
	});
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
		expect(GrokAuthRpc.methods.prepare.output).toEqual({ type: "string", enum: ["ready", "missing", "failed", "region-blocked"] });
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
		await expect(reader("xai")).rejects.toThrow("xAI OAuth refresh failed");
		expect(lists).toBe(0);
	});
});
