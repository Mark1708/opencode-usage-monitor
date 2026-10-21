/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import type { CacheV2ReadResult, CacheV2Target } from "../provider-cache.js";
import type {
	ResolvedProviderConfigV2,
	ResolvedRefreshConfigV2,
} from "../config-types.js";
import type { CredentialResolution } from "../credentials.js";
import type {
	CacheScopeMetadata,
	CredentialLease,
	NonSecretAccountMetadataReader,
	ProviderBinding,
	ProviderRegistration,
	ValidationIssue,
	ValidationResult,
} from "../providers/contracts.js";
import type { StandardUsageProvider } from "../providers/types.js";
import {
	createRefreshCoordinator,
	type MonotonicClock,
	type OneShotTimers,
	type ProviderRuntimeState,
	type RefreshCache,
	type RefreshCoordinator,
	type RefreshCredentialResolver,
} from "../refresh.js";
import type { ProviderUsageView } from "../views/types.js";

const POLICY_MANUAL: ResolvedRefreshConfigV2 = Object.freeze({
	mode: "manual",
	interval_ms: 1_000,
	timeout_ms: 250,
	stale_after_ms: 500,
});
const POLICY_AUTO: ResolvedRefreshConfigV2 = Object.freeze({
	...POLICY_MANUAL,
	mode: "automatic",
});
const ACCOUNT_SCOPE = "11111111-1111-4111-8111-111111111111";
const LEASE: CredentialLease = Object.freeze({
	secret: "fixture-credential",
	source: "env",
	variant: "fixture",
	epoch: 1,
});

type Deferred<T> = Readonly<{
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}>;

function deferred<T>(): Deferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return Object.freeze({
		promise,
		resolve: (value: T) => resolvePromise?.(value),
		reject: (error: unknown) => rejectPromise?.(error),
	});
}

async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

function snapshot(
	id: string,
	fetchedAt = 1_000,
	status: "ready" | "partial" = "ready",
): StandardUsageProvider {
	return { id, displayName: id, status, windows: [], fetchedAt };
}

class FakeClock implements MonotonicClock, OneShotTimers {
	private time: number;
	private nextId = 1;
	private tasks = new Map<
		number,
		Readonly<{ dueAt: number; callback: () => void }>
	>();

	constructor(initialTime = 1_000) {
		this.time = initialTime;
	}

	now(): number {
		return this.time;
	}

	setTimeout(callback: () => void, delayMs: number): unknown {
		const id = this.nextId;
		this.nextId += 1;
		this.tasks = new Map(this.tasks).set(
			id,
			Object.freeze({ dueAt: this.time + delayMs, callback }),
		);
		return id;
	}

	clearTimeout(handle: unknown): void {
		if (typeof handle !== "number") return;
		const next = new Map(this.tasks);
		next.delete(handle);
		this.tasks = next;
	}

	advance(milliseconds: number): void {
		this.time += milliseconds;
		const due = [...this.tasks.entries()]
			.filter(([, task]) => task.dueAt <= this.time)
			.sort(
				(left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0],
			);
		for (const [id, task] of due) {
			if (!this.tasks.has(id)) continue;
			this.clearTimeout(id);
			task.callback();
		}
	}

	get pendingCount(): number {
		return this.tasks.size;
	}
}

class LeakyTimers implements OneShotTimers {
	private callbacks: (() => void)[] = [];

	setTimeout(callback: () => void): unknown {
		this.callbacks = [...this.callbacks, callback];
		return this.callbacks.length - 1;
	}

	clearTimeout(_handle: unknown): void {
		void _handle;
	}

	run(index: number): void {
		this.callbacks[index]?.();
	}

	get count(): number {
		return this.callbacks.length;
	}
}

class TestCredentials implements RefreshCredentialResolver {
	readonly calls: string[] = [];
	disposeCount = 0;

	constructor(
		private readonly result: (
			id: string,
			call: number,
		) => CredentialResolution | Promise<CredentialResolution>,
	) {}

	async resolve(
		registration: ProviderRegistration,
	): Promise<CredentialResolution> {
		this.calls.push(registration.metadata.id);
		return this.result(registration.metadata.id, this.calls.length);
	}

	dispose(): void {
		this.disposeCount += 1;
	}
}

class TestCache implements RefreshCache {
	readonly reads: CacheV2Target[] = [];
	readonly writes: Readonly<{
		target: CacheV2Target;
		snapshot: StandardUsageProvider;
	}>[] = [];
	disposeCount = 0;

	constructor(
		private readonly entries: Readonly<
			Record<string, StandardUsageProvider>
		> = {},
	) {}

	read(target: CacheV2Target): CacheV2ReadResult {
		this.reads.push(target);
		const found = this.entries[target.providerId];
		return found
			? {
					status: "hit",
					snapshot: found,
					storage: target.scope ? "persistent" : "memory",
				}
			: { status: "miss", diagnostic: "cache-miss" };
	}

	write(
		target: CacheV2Target,
		value: StandardUsageProvider,
	): Readonly<{ status: "written" }> {
		this.writes.push(Object.freeze({ target, snapshot: value }));
		return { status: "written" };
	}

	dispose(): void {
		this.disposeCount += 1;
	}
}

type ProviderFixtureOptions = Readonly<{
	order?: number;
	scope?: CacheScopeMetadata | null | "credential";
}>;

function provider(
	id: string,
	fetchUsage: ProviderBinding["fetchUsage"],
	options: ProviderFixtureOptions = {},
): ResolvedProviderConfigV2 {
	const metadata = Object.freeze({
		id,
		displayName: id,
		catalogOrder: options.order ?? 0,
		officialApi: Object.freeze({
			baseUrls: Object.freeze(["https://api.example.test"]),
			documentationUrl: "https://docs.example.test",
			endpoints: Object.freeze([{ method: "GET" as const, path: "/usage" }]),
		}),
	});
	const credentialPolicy = Object.freeze({
		allowedSources: Object.freeze(["env" as const]),
		defaultCandidates: Object.freeze([
			{
				source: "env" as const,
				variant: "fixture",
				name: `${id.toUpperCase()}_KEY`,
			},
		]),
	});
	const binding: ProviderBinding = Object.freeze({
		metadata,
		credentialPolicy,
		fetchUsage,
		present: (): ProviderUsageView => ({
			id,
			title: id,
			status: "ready",
			metrics: [],
		}),
		resolveCacheScopeMetadata: (reader: NonSecretAccountMetadataReader) =>
			options.scope === "credential"
				? {
						accountId: `${id}-account`,
						credentialVariant:
							reader.readAccountIdentifier("credential_variant") ?? "missing",
						dataShape: { plan: "fixture" },
					}
				: (options.scope ?? null),
	});
	const registration: ProviderRegistration = Object.freeze({
		metadata,
		credentialPolicy,
		parseOptions: (): ValidationResult<ProviderBinding> => ({
			ok: true,
			value: binding,
		}),
	});
	return Object.freeze({
		id,
		order: options.order ?? 0,
		registration,
		ok: true,
		binding,
	});
}

function invalidProvider(
	id: string,
	order: number,
	issues: readonly ValidationIssue[],
): ResolvedProviderConfigV2 {
	const valid = provider(id, async () => snapshot(id), { order });
	return Object.freeze({
		id,
		order,
		registration: valid.registration,
		ok: false,
		issues: Object.freeze([...issues]),
	});
}

function credentials(
	result:
		| CredentialResolution
		| ((
				id: string,
				call: number,
		  ) => CredentialResolution | Promise<CredentialResolution>) = {
		ok: true,
		accountScope: ACCOUNT_SCOPE,
		lease: LEASE,
	},
): TestCredentials {
	return new TestCredentials(
		typeof result === "function" ? result : () => result,
	);
}

function state(
	states: readonly ProviderRuntimeState[],
	id: string,
): ProviderRuntimeState {
	const found = states.find((candidate) => candidate.id === id);
	if (!found) throw new Error(`Missing state: ${id}`);
	return found;
}

type CommitFetchGate = Readonly<{
	id: string;
	generation: number;
	requestSequence: number;
	credentialEpoch: number;
	scopeKey: string;
}>;

function invokeCommitFetchResult(
	coordinator: RefreshCoordinator,
	result: StandardUsageProvider,
	gate: CommitFetchGate,
): void {
	const candidate = Reflect.get(coordinator, "commitFetchResult");
	if (typeof candidate !== "function")
		throw new Error("Missing commitFetchResult");
	Reflect.apply(candidate, coordinator, [
		result,
		ACCOUNT_SCOPE,
		Object.freeze({ scope: null, persistentIdentity: null }),
		gate,
		LEASE.secret,
	]);
}

describe("deterministic provider refresh coordinator", () => {
	test("manual bootstrap reads cache but performs zero startup fetches and isolates config errors", async () => {
		let fetches = 0;
		const valid = provider(
			"valid",
			async () => {
				fetches += 1;
				return snapshot("valid");
			},
			{ order: 20 },
		);
		const invalid = invalidProvider("invalid", 10, [
			{ path: "options.plan", message: "invalid plan" },
		]);
		const resolver = credentials();
		const coordinator = createRefreshCoordinator({
			providers: [invalid, valid],
			policy: POLICY_MANUAL,
			credentialResolver: resolver,
			cache: new TestCache(),
			clock: new FakeClock(),
			timers: new FakeClock(),
		});

		expect(
			coordinator.getStates().map((item) => [item.id, item.status]),
		).toEqual([
			["invalid", "config_error"],
			["valid", "loading"],
		]);
		await settle();

		expect(fetches).toBe(0);
		expect(resolver.calls).toEqual(["valid"]);
		expect(state(coordinator.getStates(), "invalid").message).toBe(
			"Provider configuration is invalid",
		);
	});

	test("commits a fast automatic provider while a slow provider remains refreshing", async () => {
		const slow = deferred<StandardUsageProvider>();
		const fast = deferred<StandardUsageProvider>();
		const clock = new FakeClock();
		const emissions: (readonly ProviderRuntimeState[])[] = [];
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("fast", () => fast.promise),
				provider("slow", () => slow.promise),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		coordinator.subscribe((states) => {
			emissions.push(states);
		});
		await settle();
		expect(coordinator.getStates().map((item) => item.status)).toEqual([
			"refreshing",
			"refreshing",
		]);

		fast.resolve(snapshot("fast"));
		await settle();

		expect(state(coordinator.getStates(), "fast").status).toBe("ready");
		expect(state(coordinator.getStates(), "slow").status).toBe("refreshing");
		expect(
			emissions.some(
				(items) =>
					state(items, "fast").status === "ready" &&
					state(items, "slow").status === "refreshing",
			),
		).toBe(true);
		slow.resolve(snapshot("slow"));
	});

	test("emits fresh and stale cache hits immediately and refreshes only overdue data", async () => {
		let freshFetches = 0;
		let staleFetches = 0;
		const staleResult = deferred<StandardUsageProvider>();
		const clock = new FakeClock(1_000);
		const emissions: (readonly ProviderRuntimeState[])[] = [];
		const coordinator = createRefreshCoordinator({
			providers: [
				provider(
					"fresh",
					async () => {
						freshFetches += 1;
						return snapshot("fresh");
					},
					{ scope: "credential" },
				),
				provider("stale", () => {
					staleFetches += 1;
					return staleResult.promise;
				}),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache: new TestCache({
				fresh: snapshot("fresh", 900),
				stale: snapshot("stale", 400),
			}),
			clock,
			timers: clock,
		});
		coordinator.subscribe((states) => {
			emissions.push(states);
		});
		await settle();

		expect(freshFetches).toBe(0);
		expect(staleFetches).toBe(1);
		expect(state(coordinator.getStates(), "fresh").nextDueAt).toBe(1_900);
		expect(
			emissions.some((items) => state(items, "stale").status === "stale"),
		).toBe(true);
		expect(state(coordinator.getStates(), "stale").status).toBe("refreshing");
		staleResult.resolve(snapshot("stale"));
	});

	test("maps missing credentials to a fixed needs_auth state without cache or provider work", async () => {
		let fetches = 0;
		const cache = new TestCache();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("missing", async () => {
					fetches += 1;
					return snapshot("missing");
				}),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials({
				ok: false,
				kind: "missing",
				message: "secret-bearing detail",
				epoch: 4,
			}),
			cache,
			clock: new FakeClock(),
			timers: new FakeClock(),
		});
		await settle();

		expect(state(coordinator.getStates(), "missing")).toMatchObject({
			status: "needs_auth",
			message: "Credential is required",
			credentialEpoch: 4,
		});
		expect(cache.reads).toHaveLength(0);
		expect(fetches).toBe(0);
	});

	test("refreshes one provider or all providers on demand", async () => {
		const calls: string[] = [];
		const first = provider("first", async () => {
			calls.push("first");
			return snapshot("first");
		});
		const second = provider("second", async () => {
			calls.push("second");
			return snapshot("second");
		});
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [first, second],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();

		await coordinator.refreshProvider("first");
		expect(calls).toEqual(["first"]);
		await coordinator.refreshAll();

		expect(calls).toEqual(["first", "first", "second"]);
		expect(
			coordinator.getStates().every((item) => item.status === "ready"),
		).toBe(true);
		expect(
			coordinator.getStates().every((item) => item.nextDueAt === undefined),
		).toBe(true);
	});

	test("coalesces repeated matching requests by generation, credential epoch, and scope", async () => {
		const result = deferred<StandardUsageProvider>();
		let fetches = 0;
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider(
					"single",
					() => {
						fetches += 1;
						return result.promise;
					},
					{ scope: "credential" },
				),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();

		const first = coordinator.refreshProvider("single");
		const second = coordinator.refreshProvider("single");
		await settle();
		expect(fetches).toBe(1);
		expect(state(coordinator.getStates(), "single").requestSequence).toBe(1);

		result.resolve(snapshot("single"));
		await Promise.all([first, second]);
	});

	test("a changed credential epoch supersedes ignored aborts and gates stale cache writes", async () => {
		const older = deferred<StandardUsageProvider>();
		const newer = deferred<StandardUsageProvider>();
		let fetches = 0;
		const resolver = credentials((_id, call) => ({
			ok: true,
			accountScope: ACCOUNT_SCOPE,
			lease: Object.freeze({ ...LEASE, epoch: call >= 3 ? 2 : 1 }),
		}));
		const cache = new TestCache();
		const clock = new FakeClock();
		const configured = provider("changing", () =>
			++fetches === 1 ? older.promise : newer.promise,
		);
		const coordinator = createRefreshCoordinator({
			providers: [configured],
			policy: POLICY_MANUAL,
			credentialResolver: resolver,
			cache,
			clock,
			timers: clock,
		});
		await settle();

		const first = coordinator.refreshProvider("changing");
		await settle();
		const second = coordinator.refreshProvider("changing");
		await settle();
		newer.resolve(snapshot("changing"));
		await second;
		older.resolve(snapshot("changing"));
		await first;

		expect(state(coordinator.getStates(), "changing")).toMatchObject({
			credentialEpoch: 2,
			requestSequence: 2,
		});
		expect(cache.writes).toHaveLength(1);
		expect(cache.writes[0]?.target.credentialEpoch).toBe(2);
	});

	test("a stale request sequence cannot write cache when generation, epoch, and scope still match", async () => {
		const pending = deferred<StandardUsageProvider>();
		const cache = new TestCache();
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [provider("sequence", () => pending.promise)],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache,
			clock,
			timers: clock,
		});
		await settle();

		const refresh = coordinator.refreshProvider("sequence");
		await settle();
		invokeCommitFetchResult(coordinator, snapshot("sequence"), {
			id: "sequence",
			generation: 1,
			requestSequence: 0,
			credentialEpoch: 1,
			scopeKey: JSON.stringify(["memory", ACCOUNT_SCOPE]),
		});

		expect(state(coordinator.getStates(), "sequence")).toMatchObject({
			generation: 1,
			credentialEpoch: 1,
			requestSequence: 1,
			status: "refreshing",
		});
		expect(cache.writes).toHaveLength(0);
		pending.resolve(snapshot("sequence"));
		await refresh;
	});

	test("reconfigure ignores an older generation completing out of order", async () => {
		const older = deferred<StandardUsageProvider>();
		const newer = deferred<StandardUsageProvider>();
		const cache = new TestCache();
		const clock = new FakeClock();
		const firstConfig = provider("same", () => older.promise);
		const secondConfig = provider("same", () => newer.promise);
		const coordinator = createRefreshCoordinator({
			providers: [firstConfig],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache,
			clock,
			timers: clock,
		});
		await settle();
		coordinator.reconfigure([secondConfig], POLICY_AUTO);
		await settle();

		newer.resolve(snapshot("same"));
		await settle();
		older.resolve(snapshot("same", 1, "partial"));
		await settle();

		expect(state(coordinator.getStates(), "same")).toMatchObject({
			generation: 2,
			status: "ready",
		});
		expect(cache.writes).toHaveLength(1);
		expect(cache.writes[0]?.target.generation).toBe(2);
	});

	test("reconfigure removes, adds, reorders, changes mode, and recomputes interval deadlines", async () => {
		const clock = new FakeClock();
		const first = provider("first", async () => snapshot("first"));
		const second = provider("second", async () => snapshot("second"));
		const added = provider("added", async () => snapshot("added"));
		const coordinator = createRefreshCoordinator({
			providers: [first, second],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();
		await coordinator.refreshProvider("first");
		expect(state(coordinator.getStates(), "first").nextDueAt).toBeUndefined();

		coordinator.reconfigure([added, first], POLICY_MANUAL);
		await settle();
		expect(coordinator.getStates().map((item) => item.id)).toEqual([
			"added",
			"first",
		]);
		expect(state(coordinator.getStates(), "first").snapshot?.id).toBe("first");

		coordinator.reconfigure([first, added], {
			...POLICY_AUTO,
			interval_ms: 2_000,
		});
		expect(coordinator.getStates().map((item) => item.id)).toEqual([
			"first",
			"added",
		]);
		expect(state(coordinator.getStates(), "first").nextDueAt).toBe(3_000);
	});

	test("one-shot stale deadline emits without polling or startup fetch in manual mode", async () => {
		let fetches = 0;
		const clock = new FakeClock(1_000);
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("cached", async () => {
					fetches += 1;
					return snapshot("cached");
				}),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache({ cached: snapshot("cached", 900) }),
			clock,
			timers: clock,
		});
		await settle();
		expect(state(coordinator.getStates(), "cached").status).toBe("ready");
		expect(clock.pendingCount).toBe(1);

		clock.advance(399);
		expect(state(coordinator.getStates(), "cached").status).toBe("ready");
		clock.advance(1);

		expect(state(coordinator.getStates(), "cached").status).toBe("stale");
		expect(fetches).toBe(0);
	});

	test("failure schedules from completion and never creates a tight retry loop", async () => {
		let fetches = 0;
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("failing", async () => {
					fetches += 1;
					throw new Error("offline");
				}),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();

		expect(fetches).toBe(1);
		expect(state(coordinator.getStates(), "failing")).toMatchObject({
			status: "error",
			nextDueAt: 2_000,
		});
		clock.advance(999);
		await settle();
		expect(fetches).toBe(1);
		clock.advance(1);
		await settle();
		expect(fetches).toBe(2);
	});

	test("a large clock jump starts at most one overdue request", async () => {
		const request = deferred<StandardUsageProvider>();
		let fetches = 0;
		const clock = new FakeClock(1_000);
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("jump", () => {
					fetches += 1;
					return request.promise;
				}),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache: new TestCache({ jump: snapshot("jump", 900) }),
			clock,
			timers: clock,
		});
		await settle();
		expect(fetches).toBe(0);

		clock.advance(100_000);
		await settle();
		clock.advance(100_000);
		await settle();

		expect(fetches).toBe(1);
		expect(state(coordinator.getStates(), "jump").status).toBe("refreshing");
		request.resolve(snapshot("jump"));
	});

	test("dispose is terminal and idempotent for timers, requests, cache, resolver, and subscribers", async () => {
		const request = deferred<StandardUsageProvider>();
		const clock = new FakeClock();
		const cache = new TestCache();
		const resolver = credentials();
		let emissions = 0;
		const coordinator = createRefreshCoordinator({
			providers: [provider("disposed", () => request.promise)],
			policy: POLICY_AUTO,
			credentialResolver: resolver,
			cache,
			clock,
			timers: clock,
		});
		coordinator.subscribe(() => {
			emissions += 1;
		});
		await settle();
		coordinator.dispose();
		coordinator.dispose();
		const emissionsAtDispose = emissions;
		request.resolve(snapshot("disposed"));
		await settle();
		await coordinator.refreshAll();
		coordinator.reconfigure([], POLICY_AUTO);

		expect(cache.writes).toHaveLength(0);
		expect(cache.disposeCount).toBe(1);
		expect(resolver.disposeCount).toBe(1);
		expect(clock.pendingCount).toBe(0);
		expect(emissions).toBe(emissionsAtDispose);
	});

	test("passes exact account-safe scope and publishes deeply frozen subscriber snapshots", async () => {
		const cache = new TestCache();
		const clock = new FakeClock();
		const received: (readonly ProviderRuntimeState[])[] = [];
		const coordinator = createRefreshCoordinator({
			providers: [
				provider(
					"scoped",
					async () => ({
						...snapshot("scoped"),
						windows: [{
							id: "window",
							label: "Window",
							kind: "daily",
							period: { kind: "calendar", unit: "day" },
							usage: { kind: "percent", usedPercent: 0 },
						}],
					}),
					{ scope: "credential" },
				),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache,
			clock,
			timers: clock,
		});
		coordinator.subscribe((states) => {
			received.push(states);
		});
		await settle();
		await coordinator.refreshProvider("scoped");

		expect(cache.reads[0]?.scope).toEqual({
			accountId: "scoped-account",
			credentialVariant: "fixture",
			dataShape: { plan: "fixture" },
		});
		const latest = received.at(-1);
		expect(Object.isFrozen(latest)).toBe(true);
		expect(Object.isFrozen(latest?.[0])).toBe(true);
		expect(Object.isFrozen(latest?.[0]?.snapshot)).toBe(true);
		expect(Object.isFrozen(latest?.[0]?.snapshot?.windows)).toBe(true);
		expect(Object.isFrozen(latest?.[0]?.snapshot?.windows[0])).toBe(true);
	});

	test("converts a bootstrap credential source rejection into a scheduled fixed error", async () => {
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("bootstrap-rejection", async () =>
					snapshot("bootstrap-rejection"),
				),
			],
			policy: POLICY_AUTO,
			credentialResolver: credentials(() => {
				throw new Error("credential reader failed");
			}),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();

		expect(state(coordinator.getStates(), "bootstrap-rejection")).toMatchObject(
			{
				status: "error",
				message: "Credential source is unavailable",
				nextDueAt: 2_000,
			},
		);
	});

	test("converts an explicit refresh credential rejection without leaving refreshing state", async () => {
		const clock = new FakeClock();
		const resolver = credentials((_id, call) => {
			if (call === 1)
				return { ok: true, accountScope: ACCOUNT_SCOPE, lease: LEASE };
			throw new Error("credential source rejected");
		});
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("manual-rejection", async () => snapshot("manual-rejection")),
			],
			policy: POLICY_AUTO,
			credentialResolver: resolver,
			cache: new TestCache({
				"manual-rejection": snapshot("manual-rejection", 900),
			}),
			clock,
			timers: clock,
		});
		await settle();
		await coordinator.refreshProvider("manual-rejection");

		expect(state(coordinator.getStates(), "manual-rejection")).toMatchObject({
			status: "error",
			message: "Credential source is unavailable",
			nextDueAt: 2_000,
		});
	});

	test("exactly redacts the active credential from thrown and returned provider errors", async () => {
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("throws", async () => {
					throw new Error(`request failed ${LEASE.secret}`);
				}),
				provider("returns", async () => ({
					id: "returns",
					displayName: "returns",
					status: "error",
					statusText: `request failed ${LEASE.secret}`,
					windows: [],
				})),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();
		await coordinator.refreshAll();

		expect(
			state(coordinator.getStates(), "throws").message ===
				"request failed [redacted]",
		).toBe(true);
		expect(
			state(coordinator.getStates(), "returns").message ===
				"request failed [redacted]",
		).toBe(true);
	});

	test("rejects a successful snapshot containing the active credential before publication", async () => {
		const cache = new TestCache();
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("credential-bearing", async () => ({
					...snapshot("credential-bearing"),
					additionalProperties: { detail: LEASE.secret },
				})),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache,
			clock,
			timers: clock,
		});
		await settle();
		await coordinator.refreshProvider("credential-bearing");
		const current = state(coordinator.getStates(), "credential-bearing");

		expect(current.status === "error").toBe(true);
		expect(current.snapshot === undefined).toBe(true);
		expect(
			current.message === "Provider response contained credential data",
		).toBe(true);
		expect(cache.writes).toHaveLength(0);
	});

	test("keeps a successful state when cache write throws", async () => {
		const backing = new TestCache();
		const cache: RefreshCache = {
			read: (target) => backing.read(target),
			write: () => {
				throw new Error("cache unavailable");
			},
			dispose: () => backing.dispose(),
		};
		const clock = new FakeClock();
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("cache-rejection", async () => snapshot("cache-rejection")),
			],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache,
			clock,
			timers: clock,
		});
		await settle();
		await coordinator.refreshProvider("cache-rejection");

		expect(state(coordinator.getStates(), "cache-rejection")).toMatchObject({
			status: "ready",
		});
	});

	test("isolates throwing subscribers from state commits and later subscribers", async () => {
		const clock = new FakeClock();
		const received: (readonly ProviderRuntimeState[])[] = [];
		const coordinator = createRefreshCoordinator({
			providers: [provider("subscriber", async () => snapshot("subscriber"))],
			policy: POLICY_MANUAL,
			credentialResolver: credentials(),
			cache: new TestCache(),
			clock,
			timers: clock,
		});
		await settle();
		coordinator.subscribe(() => {
			throw new Error("subscriber failed");
		});
		coordinator.subscribe((states) => {
			received.push(states);
		});
		await coordinator.refreshProvider("subscriber");

		expect(received.length > 0).toBe(true);
		expect(state(coordinator.getStates(), "subscriber").status).toBe("ready");
	});

	test("default timers cancel an object-shaped runtime handle", async () => {
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		const handle = Object.freeze({ runtimeTimer: 1 });
		let cancelled = false;
		Reflect.set(globalThis, "setTimeout", () => handle);
		Reflect.set(globalThis, "clearTimeout", (candidate: unknown) => {
			cancelled = candidate === handle;
		});
		try {
			const coordinator = createRefreshCoordinator({
				providers: [provider("timer", async () => snapshot("timer"))],
				policy: POLICY_MANUAL,
				credentialResolver: credentials(),
				cache: new TestCache({ timer: snapshot("timer", 900) }),
				clock: new FakeClock(),
			});
			await settle();
			coordinator.dispose();
		} finally {
			Reflect.set(globalThis, "setTimeout", originalSetTimeout);
			Reflect.set(globalThis, "clearTimeout", originalClearTimeout);
		}

		expect(cancelled).toBe(true);
	});

	test("ignores a queued callback from a cancelled timer generation", async () => {
		const clock = new FakeClock(1_000);
		const timers = new LeakyTimers();
		const selected = provider("timer", async () => snapshot("timer"));
		const coordinator = createRefreshCoordinator({
			providers: [selected],
			policy: POLICY_AUTO,
			credentialResolver: credentials(),
			cache: new TestCache({ timer: snapshot("timer", 900) }),
			clock,
			timers,
		});
		await settle();

		coordinator.reconfigure([selected], { ...POLICY_AUTO, interval_ms: 5_000 });
		const scheduledAfterReconfigure = timers.count;
		timers.run(0);

		expect(timers.count).toBe(scheduledAfterReconfigure);
		expect(state(coordinator.getStates(), "timer").nextDueAt).toBe(5_900);
	});

	test("credential invalidation blocks an old fetch while a new credential list is pending", async () => {
		const oldFetch = deferred<StandardUsageProvider>();
		const newCredential = deferred<CredentialResolution>();
		const newFetch = deferred<StandardUsageProvider>();
		const cache = new TestCache();
		let fetches = 0;
		const resolver = credentials((_id, call) => {
			if (call === 3) return newCredential.promise;
			return {
				ok: true,
				accountScope: ACCOUNT_SCOPE,
				lease: Object.freeze({ ...LEASE, epoch: call >= 3 ? 2 : 1 }),
			};
		});
		const coordinator = createRefreshCoordinator({
			providers: [
				provider("rotating", () => {
					fetches += 1;
					return fetches === 1 ? oldFetch.promise : newFetch.promise;
				}),
			],
			policy: POLICY_MANUAL,
			credentialResolver: resolver,
			cache,
		});
		await settle();

		const staleRefresh = coordinator.refreshProvider("rotating");
		await settle();
		coordinator.invalidateCredentials();
		const currentRefresh = coordinator.refreshProvider("rotating");
		await settle();
		oldFetch.resolve(snapshot("rotating", 1_000, "partial"));
		await staleRefresh;

		expect(state(coordinator.getStates(), "rotating")).toMatchObject({
			generation: 2,
			status: "refreshing",
		});
		expect(state(coordinator.getStates(), "rotating").snapshot).toBeUndefined();
		expect(cache.writes).toHaveLength(0);

		newCredential.resolve({
			ok: true,
			accountScope: ACCOUNT_SCOPE,
			lease: Object.freeze({ ...LEASE, secret: "rotated-credential", epoch: 2 }),
		});
		await settle();
		newFetch.resolve(snapshot("rotating", 2_000));
		await currentRefresh;

		expect(state(coordinator.getStates(), "rotating")).toMatchObject({
			generation: 2,
			credentialEpoch: 2,
			status: "ready",
		});
		expect(cache.writes).toHaveLength(1);
		expect(cache.writes[0]?.target.generation).toBe(2);
	});

	for (const terminal of ["missing-auth", "forbidden", "unsupported"] as const) {
		test(`clears a successful snapshot and suppresses cache writes for ${terminal}`, async () => {
			const clock = new FakeClock();
			const cache = new TestCache();
			let fetches = 0;
			const coordinator = createRefreshCoordinator({
				providers: [
					provider("terminal", async () => {
						fetches += 1;
						return fetches === 1
							? snapshot("terminal", clock.now())
							: {
									...snapshot("terminal", clock.now()),
									status: terminal,
									statusText: terminal,
								};
					}),
				],
				policy: POLICY_AUTO,
				credentialResolver: credentials(),
				cache,
				clock,
				timers: clock,
			});
			await settle();
			expect(state(coordinator.getStates(), "terminal").status).toBe("ready");
			expect(cache.writes).toHaveLength(1);

			await coordinator.refreshProvider("terminal");

			expect(state(coordinator.getStates(), "terminal")).toMatchObject({
				status: terminal === "missing-auth" ? "needs_auth" : terminal,
				nextDueAt: undefined,
			});
			expect(state(coordinator.getStates(), "terminal").snapshot).toBeUndefined();
			expect(cache.writes).toHaveLength(1);
			expect(clock.pendingCount).toBe(0);
		});
	}
});
