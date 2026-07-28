/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type CacheV2Target, createProviderCacheV2 } from "../provider-cache.js";
import type { CredentialReferenceV2, ResolvedProviderConfigV2, ResolvedRefreshConfigV2 } from "../config-types.js";
import {
  type CredentialResolution,
  createCredentialResolver,
} from "../credentials.js";
import type {
  CacheScopeMetadata,
  CredentialCandidate,
  NonSecretAccountMetadataReader,
  ProviderBinding,
  ProviderRegistration,
} from "../providers/contracts.js";
import type { StandardUsageProvider } from "../providers/types.js";
import {
  createRefreshCoordinator,
  type OneShotTimers,
  type RefreshCache,
  type RefreshCredentialResolver,
} from "../refresh.js";
import type { ProviderUsageView } from "../views/types.js";

const SECRET_A = "fixture-credential-alpha";
const SECRET_B = "fixture-credential-beta";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_SCOPE_A = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_SCOPE_B = "22222222-2222-4222-8222-222222222222";
const POLICY_MANUAL: ResolvedRefreshConfigV2 = Object.freeze({
  mode: "manual",
  interval_ms: 1_000,
  timeout_ms: 250,
  stale_after_ms: 500,
});

type Deferred<T> = Readonly<{ promise: Promise<T>; resolve(value: T): void }>;

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({ promise, resolve: (value: T) => resolvePromise?.(value) });
}

function registration(candidates: readonly CredentialCandidate[]): ProviderRegistration {
  const metadata = Object.freeze({
    id: "review-provider",
    displayName: "Review provider",
    catalogOrder: 1,
    officialApi: Object.freeze({
      baseUrls: Object.freeze(["https://api.example.test"]),
      documentationUrl: "https://docs.example.test",
      endpoints: Object.freeze([{ method: "GET" as const, path: "/usage" }]),
    }),
  });
  const credentialPolicy = Object.freeze({
    allowedSources: Object.freeze(["env" as const]),
    defaultCandidates: Object.freeze([...candidates]),
  });
  return Object.freeze({
    metadata,
    credentialPolicy,
    parseOptions: () => ({ ok: false as const, issues: Object.freeze([]) }),
  });
}

function successful(result: CredentialResolution): Extract<CredentialResolution, { ok: true }> {
  if (!result.ok) throw new Error(`Expected successful resolution, received ${result.kind}`);
  return result;
}

function cacheTarget(
  scope: CacheScopeMetadata | null,
  accountScope: string,
  credentialEpoch = 1,
): CacheV2Target {
  return { providerId: "review-provider", generation: 1, credentialEpoch, accountScope, scope };
}

function usageSnapshot(percentage: number): StandardUsageProvider {
  return {
    id: "review-provider",
    displayName: "Review provider",
    status: "ready",
    windows: [{
      id: "quota",
      label: "Quota",
      kind: "monthly",
      period: { kind: "calendar", unit: "month" },
      usage: { kind: "percent", usedPercent: percentage },
      percentage,
    }],
    fetchedAt: 1_700_000_000_000,
  };
}

function nestedValue(depth: number): unknown {
  return depth === 0 ? "leaf" : { next: nestedValue(depth - 1) };
}

function hitPercentage(result: ReturnType<ReturnType<typeof createProviderCacheV2>["read"]>): number | undefined {
  return result.status === "hit" ? result.snapshot.windows[0]?.percentage : undefined;
}

function selectedProvider(
  fetchUsage: ProviderBinding["fetchUsage"],
  credential?: CredentialReferenceV2,
  scope: CacheScopeMetadata | null = null,
): ResolvedProviderConfigV2 {
  const configured = registration([
    { source: "env", variant: "first", name: "FIRST_KEY" },
    { source: "env", variant: "second", name: "SECOND_KEY" },
  ]);
  const binding: ProviderBinding = Object.freeze({
    metadata: configured.metadata,
    credentialPolicy: configured.credentialPolicy,
    fetchUsage,
    present: (): ProviderUsageView => ({ id: "review-provider", title: "Review provider", status: "ready", metrics: [] }),
    resolveCacheScopeMetadata: (_reader: NonSecretAccountMetadataReader) => scope,
  });
  return Object.freeze({
    id: "review-provider",
    order: 1,
    registration: configured,
    credential,
    ok: true,
    binding,
  });
}

class AccountMemoryCache implements RefreshCache {
  reads: readonly CacheV2Target[] = Object.freeze([]);
  writes: readonly CacheV2Target[] = Object.freeze([]);
  private entries: ReadonlyMap<string, StandardUsageProvider> = new Map();

  read(target: CacheV2Target): ReturnType<RefreshCache["read"]> {
    this.reads = Object.freeze([...this.reads, target]);
    const found = this.entries.get(this.key(target));
    return found
      ? { status: "hit", snapshot: found, storage: "memory" }
      : { status: "miss", diagnostic: "cache-miss" };
  }

  write(target: CacheV2Target, snapshot: StandardUsageProvider): Readonly<{ status: "written" }> {
    this.writes = Object.freeze([...this.writes, target]);
    this.entries = new Map(this.entries).set(this.key(target), snapshot);
    return { status: "written" };
  }

  dispose(): void {}

  private key(target: CacheV2Target): string {
    return JSON.stringify([target.providerId, target.accountScope, target.credentialEpoch]);
  }
}

class SequenceResolver implements RefreshCredentialResolver {
  private call = 0;

  constructor(private readonly results: readonly (CredentialResolution | Promise<CredentialResolution>)[]) {}

  resolve(_registration: ProviderRegistration, _reference?: CredentialReferenceV2): Promise<CredentialResolution> {
    const result = this.results[this.call];
    this.call += 1;
    if (!result) throw new Error("Missing credential result");
    return Promise.resolve(result);
  }

  dispose(): void {}

  get calls(): number {
    return this.call;
  }
}

function resolvedCredential(accountScope: string): CredentialResolution {
  return {
    ok: true,
    accountScope,
    lease: { secret: SECRET_A, source: "env", variant: "first", epoch: 1 },
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("Phase 7 refresh review blockers", () => {
  test("assigns a stable opaque account scope per resolver and credential reference identity", async () => {
    const configured = registration([
      { source: "env", variant: "first", name: "FIRST_KEY" },
      { source: "env", variant: "second", name: "SECOND_KEY" },
    ]);
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: (name) => name === "FIRST_KEY" ? SECRET_A : SECRET_B,
    });

    const first = successful(await resolver.resolve(configured, { source: "env", name: "FIRST_KEY" }));
    const same = successful(await resolver.resolve(configured, { source: "env", name: "FIRST_KEY" }));
    const second = successful(await resolver.resolve(configured, { source: "env", name: "SECOND_KEY" }));

    expect(first.lease.epoch).toBe(1);
    expect(second.lease.epoch).toBe(1);
    expect(first.accountScope).toBe(same.accountScope);
    expect(first.accountScope).not.toBe(second.accountScope);
    expect(first.accountScope).toMatch(UUID_PATTERN);
    expect(second.accountScope).toMatch(UUID_PATTERN);
    expect(JSON.stringify([first.accountScope, second.accountScope])).not.toContain("FIRST_KEY");
    expect(JSON.stringify([first.accountScope, second.accountScope])).not.toContain(SECRET_A);
    expect(JSON.stringify([first.accountScope, second.accountScope])).not.toContain(SECRET_B);
  });

  test("returns the fixed disposed failure when disposal interrupts a deferred source read", async () => {
    const pendingRead = deferred<string | undefined>();
    let reads = 0;
    const configured = registration([{ source: "env", variant: "first", name: "FIRST_KEY" }]);
    const resolver = createCredentialResolver({
      readOpenCodeEntry: () => undefined,
      readEnv: () => {
        reads += 1;
        return pendingRead.promise;
      },
    });

    const pendingResolution = resolver.resolve(configured);
    resolver.dispose();
    pendingRead.resolve(SECRET_A);

    expect(await pendingResolution).toEqual({
      ok: false,
      kind: "source",
      message: "Credential resolver is disposed",
      epoch: 0,
    });
    expect(await resolver.resolve(configured)).toEqual({
      ok: false,
      kind: "source",
      message: "Credential resolver is disposed",
      epoch: 0,
    });
    expect(reads).toBe(1);
  });

  test("requires a valid account scope and isolates null-scope memory entries", () => {
    const baseDir = join(mkdtempSync(join(tmpdir(), "refresh-review-cache-")), "cache");
    try {
      const cache = createProviderCacheV2({ baseDir });
      const missingAccountScope = {
        providerId: "review-provider",
        generation: 1,
        credentialEpoch: 1,
        scope: null,
      };

      expect(Reflect.apply(cache.write, cache, [missingAccountScope, usageSnapshot(10)])).toEqual({
        status: "rejected",
        diagnostic: "cache-invalid-input",
      });
      expect(cache.write(cacheTarget(null, "not-a-uuid"), usageSnapshot(20))).toEqual({
        status: "rejected",
        diagnostic: "cache-invalid-input",
      });
      expect(cache.write(cacheTarget(null, ACCOUNT_SCOPE_A), usageSnapshot(30)).status).toBe("written");
      expect(cache.read(cacheTarget(null, ACCOUNT_SCOPE_B))).toEqual({ status: "miss", diagnostic: "cache-miss" });
      expect(hitPercentage(cache.read(cacheTarget(null, ACCOUNT_SCOPE_A)))).toBe(30);
    } finally {
      rmSync(join(baseDir, ".."), { recursive: true, force: true });
    }
  });

  test("keeps persistent identity independent from account scope, generation, and epoch", () => {
    const baseDir = join(mkdtempSync(join(tmpdir(), "refresh-review-cache-")), "cache");
    const scope: CacheScopeMetadata = {
      accountId: "stable-account",
      credentialVariant: "fixture",
      dataShape: { plan: "stable" },
    };
    try {
      const cache = createProviderCacheV2({ baseDir });
      const initial = cacheTarget(scope, ACCOUNT_SCOPE_A, 1);
      const later = { ...cacheTarget(scope, ACCOUNT_SCOPE_B, 9), generation: 7 };

      expect(cache.write(initial, usageSnapshot(40)).status).toBe("written");
      expect(hitPercentage(cache.read(later))).toBe(40);
    } finally {
      rmSync(join(baseDir, ".."), { recursive: true, force: true });
    }
  });

  test("does not promote a null-scope cache entry across epoch-one account references", async () => {
    const cache = new AccountMemoryCache();
    const resolver = new SequenceResolver([
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_B),
    ]);
    const first = selectedProvider(async () => usageSnapshot(51), { source: "env", name: "FIRST_KEY" });
    const second = selectedProvider(async () => usageSnapshot(82), { source: "env", name: "SECOND_KEY" });
    const coordinator = createRefreshCoordinator({
      providers: [first],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
    });
    await settle();
    await coordinator.refreshProvider("review-provider");

    coordinator.reconfigure([second], POLICY_MANUAL);
    await settle();

    expect(cache.writes[0]?.accountScope).toBe(ACCOUNT_SCOPE_A);
    expect(cache.reads.at(-1)?.accountScope).toBe(ACCOUNT_SCOPE_B);
    expect(coordinator.getStates()[0]?.snapshot).toBeUndefined();
  });

  test("does not publish a cache hit belonging to another provider", async () => {
    const foreignSnapshot: StandardUsageProvider = {
      ...usageSnapshot(64),
      id: "foreign-provider",
      displayName: "Foreign provider",
    };
    const cache: RefreshCache = {
      read: () => ({ status: "hit", snapshot: foreignSnapshot, storage: "memory" }),
      write: () => ({ status: "written" }),
      dispose: () => undefined,
    };
    const resolver = new SequenceResolver([resolvedCredential(ACCOUNT_SCOPE_A)]);
    const coordinator = createRefreshCoordinator({
      providers: [selectedProvider(async () => usageSnapshot(90))],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
    });

    await settle();

    expect(coordinator.getStates()[0]?.snapshot).toBeUndefined();
  });

  test("restarts a pending same-object bootstrap on reconfigure and rejects the old completion", async () => {
    const older = deferred<CredentialResolution>();
    const cache = new AccountMemoryCache();
    cache.write(cacheTarget(null, ACCOUNT_SCOPE_B), usageSnapshot(77));
    const resolver = new SequenceResolver([older.promise, resolvedCredential(ACCOUNT_SCOPE_B)]);
    const configured = selectedProvider(async () => usageSnapshot(90));
    const coordinator = createRefreshCoordinator({
      providers: [configured],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
    });

    coordinator.reconfigure([configured], POLICY_MANUAL);
    await settle();

    expect(resolver.calls).toBe(2);
    expect(coordinator.getStates()[0]?.snapshot?.windows[0]?.percentage).toBe(77);
    older.resolve(resolvedCredential(ACCOUNT_SCOPE_A));
    await settle();
    expect(coordinator.getStates()[0]?.snapshot?.windows[0]?.percentage).toBe(77);
  });

  test("attempts resolver and cache cleanup independently while disposal stays terminal", () => {
    let resolverDisposals = 0;
    let cacheDisposals = 0;
    const resolver: RefreshCredentialResolver = {
      resolve: async () => resolvedCredential(ACCOUNT_SCOPE_A),
      dispose: () => {
        resolverDisposals += 1;
        throw new Error(`resolver cleanup exposed ${SECRET_A}`);
      },
    };
    const cache: RefreshCache = {
      read: () => ({ status: "miss", diagnostic: "cache-miss" }),
      write: () => ({ status: "written" }),
      dispose: () => {
        cacheDisposals += 1;
        throw new Error(`cache cleanup exposed ${SECRET_B}`);
      },
    };
    const coordinator = createRefreshCoordinator({
      providers: [],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
    });

    expect(() => coordinator.dispose()).not.toThrow();
    expect(() => coordinator.dispose()).not.toThrow();
    expect(resolverDisposals).toBe(1);
    expect(cacheDisposals).toBe(1);
  });

  test("rejects malformed, nonfinite, oversized, and deep snapshots before publication or cache write", async () => {
    const hostileSnapshots: readonly StandardUsageProvider[] = Object.freeze([
      { ...usageSnapshot(1), additionalProperties: { nested: new Date(0) } },
      { ...usageSnapshot(Number.POSITIVE_INFINITY) },
      { ...usageSnapshot(2), statusText: "x".repeat(300_000) },
      { ...usageSnapshot(3), additionalProperties: { nested: nestedValue(20) } },
    ]);

    for (const hostile of hostileSnapshots) {
      const cache = new AccountMemoryCache();
      const resolver = new SequenceResolver([
        resolvedCredential(ACCOUNT_SCOPE_A),
        resolvedCredential(ACCOUNT_SCOPE_A),
      ]);
      let published: readonly StandardUsageProvider[] = Object.freeze([]);
      const coordinator = createRefreshCoordinator({
        providers: [selectedProvider(async () => hostile)],
        policy: POLICY_MANUAL,
        credentialResolver: resolver,
        cache,
      });
      coordinator.subscribe((states) => {
        const snapshot = states[0]?.snapshot;
        if (snapshot) published = Object.freeze([...published, snapshot]);
      });
      await settle();
      await coordinator.refreshProvider("review-provider");

      expect(coordinator.getStates()[0]?.status).toBe("error");
      expect(published).toEqual([]);
      expect(cache.writes).toEqual([]);
      coordinator.dispose();
    }
  });

  test("checks the exact active credential before generic snapshot validation", async () => {
    const cache = new AccountMemoryCache();
    const resolver = new SequenceResolver([
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
    ]);
    const coordinator = createRefreshCoordinator({
      providers: [selectedProvider(async () => ({
        ...usageSnapshot(4),
        additionalProperties: { credentialLeak: SECRET_A, malformed: new Date(0) },
      }))],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
    });
    await settle();
    await coordinator.refreshProvider("review-provider");

    expect(coordinator.getStates()[0]?.message).toBe("Provider response contained credential data");
    expect(cache.writes).toEqual([]);
  });

  test("never invokes hostile snapshot toJSON hooks", async () => {
    let toJsonCalls = 0;
    const hostile = {
      ...usageSnapshot(5),
      toJSON: () => {
        toJsonCalls += 1;
        return usageSnapshot(99);
      },
    };
    const resolver = new SequenceResolver([
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
    ]);
    const coordinator = createRefreshCoordinator({
      providers: [selectedProvider(async () => hostile)],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache: new AccountMemoryCache(),
    });
    await settle();
    await coordinator.refreshProvider("review-provider");

    expect(toJsonCalls).toBe(0);
    expect(coordinator.getStates()[0]?.snapshot).toBeUndefined();
  });

  test("maps nonplain and throwing provider cache scopes to fixed config errors", async () => {
    class NonPlainScope implements CacheScopeMetadata {
      readonly accountId = "account";
      readonly credentialVariant = "fixture";
      readonly dataShape = Object.freeze({ plan: "stable" });
    }
    const throwingScope = new Proxy<CacheScopeMetadata>({
      accountId: "account",
      credentialVariant: "fixture",
      dataShape: { plan: "stable" },
    }, {
      getOwnPropertyDescriptor: () => { throw new Error("scope proxy invoked"); },
    });

    for (const hostileScope of [new NonPlainScope(), throwingScope]) {
      const coordinator = createRefreshCoordinator({
        providers: [selectedProvider(async () => usageSnapshot(6), undefined, hostileScope)],
        policy: POLICY_MANUAL,
        credentialResolver: new SequenceResolver([resolvedCredential(ACCOUNT_SCOPE_A)]),
        cache: new AccountMemoryCache(),
      });
      await settle();

      expect(coordinator.getStates()[0]).toMatchObject({
        status: "config_error",
        message: "Provider configuration is invalid",
      });
    }
  });

  test("retries after every synchronous provider fetch throw", async () => {
    let fetches = 0;
    const resolver = new SequenceResolver([
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
      resolvedCredential(ACCOUNT_SCOPE_A),
    ]);
    const coordinator = createRefreshCoordinator({
      providers: [selectedProvider(() => {
        fetches += 1;
        throw new Error("synchronous failure");
      })],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache: new AccountMemoryCache(),
    });
    await settle();

    await coordinator.refreshProvider("review-provider");
    await coordinator.refreshProvider("review-provider");
    await coordinator.refreshProvider("review-provider");

    expect(fetches).toBe(3);
    expect(coordinator.getStates()[0]?.status).toBe("error");
  });

  test("contains throwing timer cancellation during reschedule and disposal cleanup", async () => {
    let resolverDisposals = 0;
    let cacheDisposals = 0;
    let cancellations = 0;
    const timers: OneShotTimers = {
      setTimeout: () => Object.freeze({ timer: 1 }),
      clearTimeout: () => {
        cancellations += 1;
        throw new Error("timer cancellation failed");
      },
    };
    const resolver: RefreshCredentialResolver = {
      resolve: async () => resolvedCredential(ACCOUNT_SCOPE_A),
      dispose: () => { resolverDisposals += 1; },
    };
    const cache: RefreshCache = {
      read: () => ({ status: "hit", snapshot: { ...usageSnapshot(7), fetchedAt: Date.now() }, storage: "memory" }),
      write: () => ({ status: "written" }),
      dispose: () => { cacheDisposals += 1; },
    };
    const coordinator = createRefreshCoordinator({
      providers: [selectedProvider(async () => usageSnapshot(8))],
      policy: POLICY_MANUAL,
      credentialResolver: resolver,
      cache,
      timers,
    });
    await settle();

    expect(() => coordinator.dispose()).not.toThrow();
    expect(cancellations).toBeGreaterThan(0);
    expect(resolverDisposals).toBe(1);
    expect(cacheDisposals).toBe(1);
  });

  test("redacts and bounds oversized thrown and returned provider failures", async () => {
    const oversizedFailure = `${"x".repeat(3_000)}${SECRET_A}\nsecond line`;
    const fetches: readonly ProviderBinding["fetchUsage"][] = [
      () => { throw new Error(oversizedFailure); },
      async () => ({
        id: "review-provider",
        displayName: "Review provider",
        status: "error",
        statusText: oversizedFailure,
        windows: [],
      }),
    ];

    for (const fetchUsage of fetches) {
      const coordinator = createRefreshCoordinator({
        providers: [selectedProvider(fetchUsage)],
        policy: POLICY_MANUAL,
        credentialResolver: new SequenceResolver([
          resolvedCredential(ACCOUNT_SCOPE_A),
          resolvedCredential(ACCOUNT_SCOPE_A),
        ]),
        cache: new AccountMemoryCache(),
      });
      await settle();
      await coordinator.refreshProvider("review-provider");
      const message = coordinator.getStates()[0]?.message ?? "";

      expect(message.length).toBeGreaterThan(0);
      expect(message.length).toBeLessThanOrEqual(1_024);
      expect(message).not.toContain(SECRET_A);
      expect(message).not.toContain("\n");
    }
  });

  test("consumes rejected async subscribers without blocking later subscribers or refresh", async () => {
    let laterSubscriberCalls = 0;
    let unhandled: readonly unknown[] = Object.freeze([]);
    const onUnhandled = (reason: unknown): void => {
      unhandled = Object.freeze([...unhandled, reason]);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const coordinator = createRefreshCoordinator({
        providers: [selectedProvider(async () => usageSnapshot(9))],
        policy: POLICY_MANUAL,
        credentialResolver: new SequenceResolver([
          resolvedCredential(ACCOUNT_SCOPE_A),
          resolvedCredential(ACCOUNT_SCOPE_A),
        ]),
        cache: new AccountMemoryCache(),
      });
      coordinator.subscribe(async () => { throw new Error("async subscriber failed"); });
      coordinator.subscribe(() => { laterSubscriberCalls += 1; });
      await settle();
      await coordinator.refreshProvider("review-provider");
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));

      expect(unhandled).toEqual([]);
      expect(laterSubscriberCalls).toBeGreaterThan(0);
      expect(coordinator.getStates()[0]?.status).toBe("ready");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
