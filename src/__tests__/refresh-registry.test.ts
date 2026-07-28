/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { CONFIG_DEFAULTS } from "../config.js";
import { createRefreshGuard } from "../tui.js";
import {
  getActiveAdapters,
  refreshAdapters,
} from "../providers/registry.js";
import type {
  ProviderContext,
  UsageProviderAdapter,
} from "../providers/types.js";
import { makeCtx } from "./_helpers.js";

describe("refresh orchestration", () => {
  test("refreshAll uses Promise.allSettled and keeps successful providers", async () => {
    const okAdapter: UsageProviderAdapter = {
      id: "ok",
      displayName: "ok",
      isAvailable: () => true,
      fetchUsage: async () => ({ id: "ok", displayName: "ok", status: "ready", windows: [] }),
    };
    const badAdapter: UsageProviderAdapter = {
      id: "bad",
      displayName: "bad",
      isAvailable: () => true,
      fetchUsage: async () => { throw new Error("token=abc123def456ghi789"); },
    };
    const result = await refreshAdapters(
      [okAdapter, badAdapter],
      makeCtx(),
      CONFIG_DEFAULTS,
      new AbortController().signal,
    );
    expect(result.ok?.status).toBe("ready");
    expect(result.bad?.status).toBe("error");
    expect(result.bad?.errorMessage).toBe("[redacted]");
  });

  test("createRefreshGuard prevents overlapping refreshes", () => {
    const guard = createRefreshGuard();
    expect(guard.start()).toBe(true);
    expect(guard.start()).toBe(false);
    guard.finish();
    expect(guard.isActive).toBe(false);
  });
});

describe("registry config gating", () => {
  test("disabled providers are skipped before fetchUsage", async () => {
    let fetchCount = 0;
    const adapter: UsageProviderAdapter = {
      id: "deepseek",
      displayName: "deepseek",
      configKey: "show_deepseek",
      isAvailable: () => true,
      fetchUsage: async () => {
        fetchCount += 1;
        return { id: "deepseek", displayName: "deepseek", status: "ready", windows: [] };
      },
    };

    const result = await refreshAdapters(
      [adapter],
      makeCtx(),
      { ...CONFIG_DEFAULTS, show_deepseek: false },
      new AbortController().signal,
    );

    expect(fetchCount).toBe(0);
    expect(result).toEqual({});
  });

  test("show_deepseek=false hides deepseek adapter", () => {
    const ctx: ProviderContext = makeCtx({}, { DEEPSEEK_API_KEY: "k", ZHIPU_API_KEY: "k2" });
    const active = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_deepseek: false });
    expect(active.map((adapter) => adapter.id)).not.toContain("deepseek");
  });

  test("show_deepseek=true keeps deepseek adapter", () => {
    const ctx: ProviderContext = makeCtx({}, { DEEPSEEK_API_KEY: "k" });
    const active = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_deepseek: true });
    expect(active.map((adapter) => adapter.id)).toContain("deepseek");
  });

  test("existing show_openai/show_zai gating still works", () => {
    const ctx: ProviderContext = makeCtx({}, { OPENAI_API_KEY: "k", ZHIPU_API_KEY: "k2" });
    const hidden = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS, show_openai: false, show_zai: false });
    expect(hidden.map((adapter) => adapter.id)).not.toContain("openai");
    expect(hidden.map((adapter) => adapter.id)).not.toContain("zai");
    const shown = getActiveAdapters(ctx, { ...CONFIG_DEFAULTS });
    expect(shown.map((adapter) => adapter.id)).toContain("openai");
    expect(shown.map((adapter) => adapter.id)).toContain("zai");
  });
});
