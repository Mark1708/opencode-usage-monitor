/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CACHE_V2_SCHEMA_VERSION,
  type CacheV2Target,
  createProviderCacheV2,
} from "../provider-cache.js";
import type { CacheScopeMetadata } from "../providers/contracts.js";
import type { StandardUsageProvider } from "../providers/types.js";

const ACCOUNT_SCOPE = "11111111-1111-4111-8111-111111111111";

const scope = (
  accountId = "account-1",
  credentialVariant = "zai",
  dataShape: CacheScopeMetadata["dataShape"] = { plan: "enterprise" },
): CacheScopeMetadata => ({ accountId, credentialVariant, dataShape });

const target = (
  cacheScope: CacheScopeMetadata | null = scope(),
  overrides: Partial<Omit<CacheV2Target, "scope">> = {},
): CacheV2Target => ({
  providerId: "zai",
  generation: 1,
  credentialEpoch: 1,
  accountScope: ACCOUNT_SCOPE,
  scope: cacheScope,
  ...overrides,
});

const snapshot = (
  id = "zai",
  value = 25,
  status: "ready" | "partial" = "ready",
): StandardUsageProvider => ({
  id,
  displayName: id,
  status,
  windows: [{
    id: "quota",
    label: "quota",
    kind: "monthly",
    period: { kind: "calendar", unit: "month" },
    usage: { kind: "percent", usedPercent: value },
    percentage: value,
  }],
  fetchedAt: 1_700_000_000_000,
});

describe("provider cache v2", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(mkdtempSync(join(tmpdir(), "usage-monitor-cache-")), "cache");
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(join(baseDir, ".."), { recursive: true, force: true });
  });

  test("treats a cache v1 file as a cold miss", () => {
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(join(baseDir, "usage-monitor.json"), JSON.stringify({
      version: 1,
      providers: { zai: snapshot() },
    }));

    const cache = createProviderCacheV2({ baseDir });

    expect(cache.read(target())).toEqual({ status: "miss", diagnostic: "cache-miss" });
  });

  test("isolates persistent entries by account, options, and credential variant", () => {
    const cache = createProviderCacheV2({ baseDir });
    const accountA = target(scope("account-a", "zai", { plan: "enterprise", region: "eu" }));
    const accountB = target(scope("account-b", "zai", { plan: "enterprise", region: "eu" }));
    const optionsB = target(scope("account-a", "zai", { plan: "enterprise", region: "us" }));
    const variantB = target(scope("account-a", "zhipu", { plan: "enterprise", region: "eu" }));

    expect(cache.write(accountA, snapshot("zai", 11))).toEqual({ status: "written", storage: "persistent" });
    expect(cache.write(accountB, snapshot("zai", 22))).toEqual({ status: "written", storage: "persistent" });
    expect(cache.write(optionsB, snapshot("zai", 33))).toEqual({ status: "written", storage: "persistent" });
    expect(cache.write(variantB, snapshot("zai", 44))).toEqual({ status: "written", storage: "persistent" });

    const restarted = createProviderCacheV2({ baseDir });
    expect(hitPercentage(restarted.read(accountA))).toBe(11);
    expect(hitPercentage(restarted.read(accountB))).toBe(22);
    expect(hitPercentage(restarted.read(optionsB))).toBe(33);
    expect(hitPercentage(restarted.read(variantB))).toBe(44);
    expect(cacheFiles(baseDir)).toHaveLength(4);
  });

  test("reuses persistent identity across generations and credential epochs", () => {
    const initial = target(scope("stable-account"), { generation: 1, credentialEpoch: 1 });
    const later = target(scope("stable-account"), { generation: 9, credentialEpoch: 7 });
    const cache = createProviderCacheV2({ baseDir });

    expect(cache.write(initial, snapshot("zai", 47))).toEqual({ status: "written", storage: "persistent" });

    const restarted = createProviderCacheV2({ baseDir });
    expect(restarted.read(later)).toMatchObject({ status: "hit", storage: "persistent" });
    expect(hitPercentage(restarted.read(later))).toBe(47);
    expect(cacheFiles(baseDir)).toHaveLength(1);
  });

  test("uses delimiter-safe canonical scope encoding and sorted data shape", () => {
    const cache = createProviderCacheV2({ baseDir });
    const first = target(scope("a:b", "c", { z: 1, a: "x|y" }));
    const same = target(scope("a:b", "c", { a: "x|y", z: 1 }));
    const delimiterShifted = target(scope("a", "b:c", { a: "x|y", z: 1 }));

    expect(cache.write(first, snapshot("zai", 17)).status).toBe("written");
    expect(hitPercentage(createProviderCacheV2({ baseDir }).read(same))).toBe(17);
    expect(createProviderCacheV2({ baseDir }).read(delimiterShifted)).toEqual({
      status: "miss",
      diagnostic: "cache-miss",
    });
  });

  test("keeps null scope in memory, reuses generations, and isolates credential epochs", () => {
    const cache = createProviderCacheV2({ baseDir });
    const memoryTarget = target(null);

    expect(cache.write(memoryTarget, snapshot("zai", 61))).toEqual({ status: "written", storage: "memory" });
    expect(hitPercentage(cache.read(memoryTarget))).toBe(61);
    expect(hitPercentage(cache.read(target(null, { generation: 2 })))).toBe(61);
    expect(cache.read(target(null, { credentialEpoch: 2 }))).toEqual({ status: "miss", diagnostic: "cache-miss" });
    expect(cacheFiles(baseDir)).toEqual([]);
    expect(createProviderCacheV2({ baseDir }).read(memoryTarget)).toEqual({ status: "miss", diagnostic: "cache-miss" });
  });

  test("promotes persistent hits into memory", () => {
    const writer = createProviderCacheV2({ baseDir });
    expect(writer.write(target(), snapshot("zai", 52)).status).toBe("written");

    const cache = createProviderCacheV2({ baseDir });
    expect(cache.read(target())).toMatchObject({ status: "hit", storage: "persistent" });
    unlinkSync(join(baseDir, onlyCacheFile(baseDir)));

    expect(cache.read(target())).toMatchObject({ status: "hit", storage: "memory" });
    expect(hitPercentage(cache.read(target()))).toBe(52);
  });

  test("persists ready and valid partial snapshots but rejects unsuccessful states", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot("zai", 1, "partial")).status).toBe("written");

    for (const status of ["loading", "missing-auth", "forbidden", "unsupported", "error"] as const) {
      const failed: StandardUsageProvider = { id: "zai", displayName: "zai", status, windows: [] };
      expect(cache.write(target(scope(`account-${status}`)), failed)).toEqual({
        status: "rejected",
        diagnostic: "snapshot-invalid",
      });
    }
    expect(cacheFiles(baseDir)).toHaveLength(1);
  });

  test("rejects recursive secret-like keys and values without writing", () => {
    const cache = createProviderCacheV2({ baseDir });
    const secretKey = {
      ...snapshot(),
      details: [{ key: "access_token", label: "ordinary", value: { kind: "text", value: "ordinary-value" }, visibility: "detail" }],
    } satisfies StandardUsageProvider;
    const secretValue = {
      ...snapshot(),
      details: [{ key: "safe", label: "safe", value: { kind: "text", value: "Bearer abcdefghijklmnopqrstuvwxyz" }, visibility: "detail" }],
    } satisfies StandardUsageProvider;

    expect(cache.write(target(), secretKey)).toEqual({ status: "rejected", diagnostic: "snapshot-invalid" });
    expect(cache.write(target(), secretValue)).toEqual({ status: "rejected", diagnostic: "snapshot-invalid" });
    expect(cacheFiles(baseDir)).toEqual([]);
  });

  test("rejects normalized secret-bearing keys recursively in objects and arrays", () => {
    const cache = createProviderCacheV2({ baseDir });
    const secretKeys = [
      "refreshToken", "refresh_token", "refresh-token", "sessionToken", "idToken",
      "clientSecret", "privateKey", "cookie", "session", "authorization",
      "nestedCredentialReference", "userPasswordHint",
    ];

    for (const [index, key] of secretKeys.entries()) {
      const unsafe = {
        ...snapshot(),
        details: [{ key, label: "safe", value: { kind: "text", value: `ordinary-value-${index}` }, visibility: "detail" }],
      } satisfies StandardUsageProvider;
      expect(cache.write(target(scope(`account-${index}`)), unsafe)).toEqual({
        status: "rejected",
        diagnostic: "snapshot-invalid",
      });
    }
    expect(cacheFiles(baseDir)).toEqual([]);
  });

  test("creates a private directory and private regular file", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");

    const filePath = join(baseDir, onlyCacheFile(baseDir));
    expect(statSync(baseDir).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(lstatSync(filePath).isFile()).toBe(true);
  });

  test("rejects path traversal inputs and symlink cache files", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.read(target(scope(), { providerId: "../escape" }))).toEqual({
      status: "invalid",
      diagnostic: "cache-invalid-input",
    });
    expect(cache.write(target(scope("account\u0000bad")), snapshot())).toEqual({
      status: "rejected",
      diagnostic: "cache-invalid-input",
    });
    expect(cache.write(target(), snapshot()).status).toBe("written");

    const filePath = join(baseDir, onlyCacheFile(baseDir));
    const alternate = join(baseDir, "alternate.json");
    writeFileSync(alternate, readFileSync(filePath));
    unlinkSync(filePath);
    symlinkSync(alternate, filePath);

    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({
      status: "invalid",
      diagnostic: "cache-invalid",
    });
  });

  test("totally rejects bigint, accessor, proxy, nonplain, and oversized cache scopes", () => {
    const cache = createProviderCacheV2({ baseDir });
    const accessorScope = Object.defineProperty({}, "accountId", {
      enumerable: true,
      get: () => { throw new Error("scope getter invoked"); },
    });
    const proxyScope = new Proxy(scope(), {
      getOwnPropertyDescriptor: () => { throw new Error("scope proxy invoked"); },
    });
    const oversizedShape = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`field${index}`, index]));
    const hostileScopes: readonly unknown[] = [
      { accountId: "account", credentialVariant: "fixture", dataShape: { plan: 1n } },
      accessorScope,
      proxyScope,
      new Date(0),
      scope("x".repeat(513)),
      { accountId: "account", credentialVariant: "fixture", dataShape: oversizedShape },
    ];

    for (const hostileScope of hostileScopes) {
      const hostileTarget = { ...target(), scope: hostileScope };
      expect(() => Reflect.apply(cache.read, cache, [hostileTarget])).not.toThrow();
      expect(Reflect.apply(cache.read, cache, [hostileTarget])).toEqual({
        status: "invalid",
        diagnostic: "cache-invalid-input",
      });
    }
  });

  test("rejects an absolute base directory outside the trusted temporary directory", () => {
    const untrustedBaseDir = join(process.cwd(), "cache-untrusted");
    const cache = createProviderCacheV2({ baseDir: untrustedBaseDir });

    expect(cache.read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid-input" });
    expect(cache.write(target(), snapshot())).toEqual({ status: "rejected", diagnostic: "cache-invalid-input" });
  });

  test("returns sanitized invalid results for corrupt, oversized, wrong-schema, and wrong-digest files", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");
    const filePath = join(baseDir, onlyCacheFile(baseDir));

    writeFileSync(filePath, "not-json");
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid" });

    writeFileSync(filePath, Buffer.alloc(600_000, 65));
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid" });

    expect(cache.write(target(), snapshot()).status).toBe("written");
    replaceEnvelope(filePath, { version: CACHE_V2_SCHEMA_VERSION + 1 });
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid" });

    expect(cache.write(target(), snapshot()).status).toBe("written");
    replaceEnvelope(filePath, { scopeDigest: "0".repeat(64) });
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid" });

    expect(cache.write(target(), snapshot()).status).toBe("written");
    replaceEnvelope(filePath, { providerId: "deepseek" });
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid" });
  });

  test("rejects oversized and excessively deep snapshots", () => {
    const cache = createProviderCacheV2({ baseDir });
    const oversized = { ...snapshot(), statusText: "x".repeat(300_000) } satisfies StandardUsageProvider;
    const deepValue = nestedValue(20);
    const deep = {
      ...snapshot(),
      details: [{ key: "deep", label: "deep", value: deepValue, visibility: "detail" }],
    } as unknown as StandardUsageProvider;

    expect(cache.write(target(), oversized)).toEqual({ status: "rejected", diagnostic: "snapshot-invalid" });
    expect(cache.write(target(), deep)).toEqual({ status: "rejected", diagnostic: "snapshot-invalid" });
  });

  test("rejects snapshots with throwing enumerable getters or proxy traps without throwing", () => {
    const cache = createProviderCacheV2({ baseDir });
    const throwingGetter = Object.defineProperty({ ...snapshot() }, "windows", {
      enumerable: true,
      get: () => { throw new Error("getter invoked"); },
    });
    const throwingProxy = new Proxy(snapshot(), {
      ownKeys: () => { throw new Error("proxy invoked"); },
    });

    expect(() => Reflect.apply(cache.write, cache, [target(), throwingGetter])).not.toThrow();
    expect(Reflect.apply(cache.write, cache, [target(), throwingGetter])).toEqual({
      status: "rejected",
      diagnostic: "snapshot-invalid",
    });
    expect(() => Reflect.apply(cache.write, cache, [target(), throwingProxy])).not.toThrow();
    expect(Reflect.apply(cache.write, cache, [target(), throwingProxy])).toEqual({
      status: "rejected",
      diagnostic: "snapshot-invalid",
    });
  });

  test("uses unique atomic temporary files and leaves no orphans after repeated writes", async () => {
    const cache = createProviderCacheV2({ baseDir });
    const writes = Array.from({ length: 24 }, (_, index) => (
      Promise.resolve().then(() => cache.write(target(), snapshot("zai", index)))
    ));

    const results = await Promise.all(writes);
    expect(results.every((result) => result.status === "written")).toBe(true);
    expect(cacheFiles(baseDir)).toHaveLength(1);
    expect(readdirSync(baseDir).some((name) => name.includes(".tmp-"))).toBe(false);
    expect(createProviderCacheV2({ baseDir }).read(target()).status).toBe("hit");
  });

  test("cleans a unique temporary file when atomic rename fails", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");
    const filePath = join(baseDir, onlyCacheFile(baseDir));
    unlinkSync(filePath);
    mkdirSync(filePath);

    expect(cache.write(target(), snapshot("zai", 99))).toEqual({
      status: "error",
      diagnostic: "cache-write-failed",
    });
    expect(readdirSync(baseDir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("removes only owned private regular stale temporary files", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");
    const cacheFile = onlyCacheFile(baseDir);
    const privateTemp = join(baseDir, `${cacheFile}.tmp-private`);
    const permissiveTemp = join(baseDir, `${cacheFile}.tmp-permissive`);
    const symlinkTemp = join(baseDir, `${cacheFile}.tmp-link`);
    writeFileSync(privateTemp, "stale", { mode: 0o600 });
    writeFileSync(permissiveTemp, "stale", { mode: 0o644 });
    symlinkSync(privateTemp, symlinkTemp);
    utimesSync(privateTemp, new Date(0), new Date(0));

    expect(cache.write(target(), snapshot("zai", 88)).status).toBe("written");

    expect(() => lstatSync(privateTemp)).toThrow();
    expect(lstatSync(permissiveTemp).isFile()).toBe(true);
    expect(lstatSync(symlinkTemp).isSymbolicLink()).toBe(true);
  });

  test("retains an active private temporary file", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");
    const activeTemp = join(baseDir, `${onlyCacheFile(baseDir)}.tmp-active`);
    writeFileSync(activeTemp, "active", { mode: 0o600 });

    expect(cache.write(target(), snapshot("zai", 89)).status).toBe("written");

    expect(lstatSync(activeTemp).isFile()).toBe(true);
  });

  test("clones and deeply freezes snapshots stored in memory", () => {
    const cache = createProviderCacheV2({ baseDir });
    const original = snapshot("zai", 73);
    expect(cache.write(target(null), original).status).toBe("written");
    firstWindow(original).percentage = 1;

    const result = cache.read(target(null));
    expect(hitPercentage(result)).toBe(73);
    if (result.status !== "hit") throw new Error("expected cache hit");
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.windows)).toBe(true);
    expect(Object.isFrozen(result.snapshot.windows[0])).toBe(true);
    expect(Reflect.set(firstWindow(result.snapshot), "percentage", 2)).toBe(false);
    expect(hitPercentage(cache.read(target(null)))).toBe(73);
  });

  test("dispose is terminal and idempotent without deleting persistent entries", () => {
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(null), snapshot("zai", 10)).status).toBe("written");
    expect(cache.write(target(), snapshot("zai", 20)).status).toBe("written");

    cache.dispose();
    cache.dispose();

    expect(cache.read(target(null))).toEqual({ status: "invalid", diagnostic: "cache-invalid-input" });
    expect(cache.read(target())).toEqual({ status: "invalid", diagnostic: "cache-invalid-input" });
    expect(cache.write(target(), snapshot("zai", 30))).toEqual({
      status: "rejected",
      diagnostic: "cache-invalid-input",
    });
    expect(hitPercentage(createProviderCacheV2({ baseDir }).read(target()))).toBe(20);
  });

  test("rejects non-regular cache paths and repairs permissive directory mode", () => {
    mkdirSync(baseDir, { recursive: true, mode: 0o777 });
    chmodSync(baseDir, 0o777);
    const cache = createProviderCacheV2({ baseDir });
    expect(cache.write(target(), snapshot()).status).toBe("written");
    expect(statSync(baseDir).mode & 0o777).toBe(0o700);

    const filePath = join(baseDir, onlyCacheFile(baseDir));
    unlinkSync(filePath);
    mkdirSync(filePath);
    expect(createProviderCacheV2({ baseDir }).read(target())).toEqual({
      status: "invalid",
      diagnostic: "cache-invalid",
    });
  });
});

type PersistedEnvelope = Readonly<{
  version: number;
  providerId: string;
  scopeDigest: string;
  snapshot: StandardUsageProvider;
}>;

function cacheFiles(baseDir: string): string[] {
  try {
    return readdirSync(baseDir).filter((name) => name.endsWith(".json") && name !== "usage-monitor.json");
  } catch {
    return [];
  }
}

function onlyCacheFile(baseDir: string): string {
  const files = cacheFiles(baseDir);
  const file = files[0];
  if (files.length !== 1 || file === undefined) throw new Error("expected one cache file");
  return file;
}

function firstWindow(value: StandardUsageProvider): StandardUsageProvider["windows"][number] {
  const window = value.windows[0];
  if (!window) throw new Error("expected a usage window");
  return window;
}

function hitPercentage(result: ReturnType<ReturnType<typeof createProviderCacheV2>["read"]>): number | undefined {
  if (result.status !== "hit") return undefined;
  return result.snapshot.windows[0]?.percentage;
}

function replaceEnvelope(filePath: string, replacement: Partial<PersistedEnvelope>): void {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as PersistedEnvelope;
  writeFileSync(filePath, JSON.stringify({ ...parsed, ...replacement }));
}

function nestedValue(depth: number): unknown {
  return depth === 0 ? "leaf" : { next: nestedValue(depth - 1) };
}
