/// <reference types="bun" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  filterFreshProviders,
  getCachePath,
  isProviderFresh,
  readCache,
  setCacheDirForTests,
  staleProviderIds,
  writeCache,
} from "../cache.js";
import type { StandardUsageProvider } from "../providers/types.js";
import { restoreCacheDir } from "./_helpers.js";

describe("cache module", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "usage-monitor-test-"));
    setCacheDirForTests(tmpDir);
  });

  afterEach(() => {
    restoreCacheDir();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("readCache returns null for missing file", () => {
    expect(readCache()).toBeNull();
  });

  test("readCache returns null for corrupt JSON", () => {
    writeFileSync(join(tmpDir, "usage-monitor.json"), "not json{{{", "utf-8");
    expect(readCache()).toBeNull();
  });

  test("readCache returns null for wrong version", () => {
    writeFileSync(join(tmpDir, "usage-monitor.json"), JSON.stringify({ version: 99, providers: {} }), "utf-8");
    expect(readCache()).toBeNull();
  });

  test("writeCache + readCache roundtrip preserves provider data", () => {
    const providers: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 30_000 },
    };
    writeCache(providers);
    const cached = readCache();
    expect(cached).not.toBeNull();
    expect(cached!.openai.status).toBe("ready");
    expect(cached!.openai.fetchedAt).toBe(providers.openai.fetchedAt);
  });

  test("writeCache creates directory if missing", () => {
    setCacheDirForTests(join(tmpDir, "nested", "deep"));
    const providers: Record<string, StandardUsageProvider> = {
      x: { id: "x", displayName: "x", status: "ready", windows: [] },
    };
    writeCache(providers);
    expect(existsSync(getCachePath())).toBe(true);
    expect(readCache()).not.toBeNull();
  });

  test("isProviderFresh returns true for recent fetchedAt", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [], fetchedAt: Date.now() - 30_000 };
    expect(isProviderFresh(provider, 60_000)).toBe(true);
  });

  test("isProviderFresh returns false for stale data", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 };
    expect(isProviderFresh(provider, 60_000)).toBe(false);
  });

  test("isProviderFresh returns false when fetchedAt is undefined", () => {
    const provider: StandardUsageProvider = { id: "x", displayName: "x", status: "ready", windows: [] };
    expect(isProviderFresh(provider, 60_000)).toBe(false);
  });

  test("filterFreshProviders keeps only fresh entries", () => {
    const cached: Record<string, StandardUsageProvider> = {
      fresh: { id: "fresh", displayName: "fresh", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
      stale: { id: "stale", displayName: "stale", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 },
    };
    const result = filterFreshProviders(cached, 60_000);
    expect(Object.keys(result)).toEqual(["fresh"]);
  });

  test("staleProviderIds identifies stale providers", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 120_000 },
    };
    expect(staleProviderIds(cached, ["openai"], 60_000)).toContain("openai");
  });

  test("staleProviderIds returns all IDs when cache is null", () => {
    expect(staleProviderIds(null, ["openai", "zai"], 60_000)).toEqual(["openai", "zai"]);
  });

  test("staleProviderIds returns empty for all-fresh cache", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
    };
    expect(staleProviderIds(cached, ["openai"], 60_000)).toEqual([]);
  });

  test("staleProviderIds returns ID when missing from cache", () => {
    const cached: Record<string, StandardUsageProvider> = {
      openai: { id: "openai", displayName: "openai", status: "ready", windows: [], fetchedAt: Date.now() - 10_000 },
    };
    expect(staleProviderIds(cached, ["openai", "zai"], 60_000)).toEqual(["zai"]);
  });
});
