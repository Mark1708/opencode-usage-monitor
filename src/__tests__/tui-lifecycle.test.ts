/// <reference types="bun" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

import usagePlugin from "../tui.js";
import { setCacheDirForTests } from "../cache.js";
import type {
  ProviderContext,
  StandardUsageProvider,
  UsageMonitorConfig,
  UsageProviderAdapter,
} from "../providers/types.js";
import { restoreCacheDir } from "./_helpers.js";

afterEach(() => {
  restoreCacheDir();
  mock.restore();
});

describe("refresh orchestration", () => {
  test("loading state is not shown during refresh", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "usage-monitor-no-loading-"));
    setCacheDirForTests(tmpDir);

    let resolveFetch: (provider: StandardUsageProvider) => void = () => undefined;
    const pendingProvider = new Promise<StandardUsageProvider>((resolve) => { resolveFetch = resolve; });
    const slowAdapter: UsageProviderAdapter = {
      id: "slow",
      displayName: "slow",
      isAvailable: () => true,
      fetchUsage: async () => pendingProvider,
    };

    mock.module("../providers/registry.js", () => ({
      PROVIDER_ADAPTERS: Object.freeze([slowAdapter]) as readonly UsageProviderAdapter[],
      selectActiveAdapters: (adapters: readonly UsageProviderAdapter[]) => [...adapters],
      refreshAdapters: async (
        adapters: readonly UsageProviderAdapter[],
        ctx: ProviderContext,
        _config: Required<UsageMonitorConfig>,
        _signal: AbortSignal,
      ): Promise<Record<string, StandardUsageProvider>> => {
        const results = await Promise.allSettled(adapters.map((adapter) => adapter.fetchUsage(ctx, new AbortController().signal)));
        return Object.fromEntries(results.map((result, index) => {
          const adapter = adapters[index];
          if (!adapter) return ["unknown", { id: "unknown", displayName: "unknown", status: "error" as const, errorMessage: "missing adapter", windows: [] }];
          if (result.status === "fulfilled") return [adapter.id, result.value];
          return [adapter.id, { id: adapter.id, displayName: adapter.displayName, status: "error" as const, errorMessage: String(result.reason), windows: [] }];
        }));
      },
      getActiveAdapters: () => [slowAdapter],
      refreshAllAdapters: async (
        _ctx: ProviderContext,
        _config: Required<UsageMonitorConfig>,
        _signal: AbortSignal,
      ): Promise<Record<string, StandardUsageProvider>> => {
        const provider = await slowAdapter.fetchUsage(_ctx, _signal);
        return { [provider.id]: provider };
      },
    }));

    let renderCount = 0;
    let dispose: () => void = () => undefined;
    const api = {
      renderer: { requestRender: () => { renderCount += 1; } },
      lifecycle: { onDispose: (callback: () => void) => { dispose = callback; } },
      slots: { register: () => undefined },
      theme: { current: { accent: "", background: "", borderActive: "", text: "", textMuted: "" } },
    } as unknown as Parameters<NonNullable<TuiPluginModule["tui"]>>[0];
    const options = {} as Parameters<NonNullable<TuiPluginModule["tui"]>>[1];
    const meta = {} as Parameters<NonNullable<TuiPluginModule["tui"]>>[2];

    if (usagePlugin.tui === undefined) throw new Error("missing tui entrypoint");
    await usagePlugin.tui(api, options, meta);
    expect(renderCount).toBe(0);

    resolveFetch({ id: "slow", displayName: "slow", status: "ready", windows: [], fetchedAt: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderCount).toBe(1);
    dispose();
    rmSync(tmpDir, { recursive: true });
  });
});
