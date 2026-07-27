/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { normalizeDeepseekBalance, deepseekUsageAdapter } from "../providers/deepseek.js";
import { normalizeWhamUsage, openAIUsageAdapter } from "../providers/openai.js";
import { normalizeZaiQuota, zaiUsageAdapter } from "../providers/zai.js";
import { providerToView } from "../views/index.js";
import { CONFIG_DEFAULTS } from "../config.js";
import {
  captureRequest,
  deepseekFixture,
  makeCtx,
  mockJsonResponse,
  nowMs,
  openAiFixture,
  renderedMetrics,
  restoreFetch,
  withoutUsageEnv,
  zaiFixture,
} from "./_helpers.js";

afterEach(() => {
  restoreFetch();
});

describe("provider normalization", () => {
  test("OpenAI adapter returns StandardUsageProvider and reports missing auth", async () => {
    mockJsonResponse(openAiFixture());
    const provider = await openAIUsageAdapter.fetchUsage(makeCtx({ openai: { access: "tok" } }), new AbortController().signal);
    expect(provider.id).toBe("openai");
    expect(provider.status).toBe("ready");
    expect(provider.plan).toBe("prolite");
    expect(provider.windows[0]?.label).toBe("5h");
    expect(provider.alerts?.[0]?.label).toBe("codex LIMIT");
    expect(await openAIUsageAdapter.fetchUsage(makeCtx(), new AbortController().signal)).toMatchObject({ status: "missing-auth", statusText: "auth missing" });
  });

  test("OpenAI partial endpoint data does not crash", () => {
    const provider = normalizeWhamUsage({ plan_type: "prolite", credits: { balance: "1" } }, nowMs());
    const view = providerToView(provider);
    expect(provider.status).toBe("partial");
    expect(view.metrics.map((metric) => metric.label)).toContain("credits");
  });

  test("Z.AI quota with 3 limits returns standard windows and model breakdown", () => {
    const provider = normalizeZaiQuota(zaiFixture(), "https://api.z.ai", nowMs());
    expect(provider.status).toBe("ready");
    expect(provider.plan).toBe("max");
    expect(provider.windows).toHaveLength(3);
    expect(provider.windows.map((window) => window.label)).toEqual(["5h", "week", "month"]);
    expect(provider.modelBreakdown?.[0]).toMatchObject({ label: "glm-5.1", used: 123 });
  });
});

describe("deepseek balance provider", () => {
  test("normalizeDeepseekBalance maps CNY total to a credits window", () => {
    const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
    expect(provider.id).toBe("deepseek");
    expect(provider.status).toBe("ready");
    expect(provider.windows).toHaveLength(1);
    const window = provider.windows[0]!;
    expect(window.label).toBe("balance");
    expect(window.kind).toBe("credits");
    expect(window.currentValue).toBe(10.53);
    expect(window.unitLabel).toBe("CNY");
    expect(provider.additionalProperties?.deepseekGrantedAmount).toBe(1.23);
    expect(provider.additionalProperties?.deepseekToppedAmount).toBe(9.30);
  });

  test("view shows balance in main line and granted/topped-up in details", () => {
    const provider = normalizeDeepseekBalance(deepseekFixture(), nowMs());
    const collapsed = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: false });
    expect(collapsed).toContain("balance");
    expect(collapsed).toContain("\u00a510.53");
    expect(collapsed).not.toContain("granted");
    expect(collapsed).not.toContain("topped-up");

    const expanded = renderedMetrics(provider, { ...CONFIG_DEFAULTS, show_details: true });
    expect(expanded).toContain("granted");
    expect(expanded).toContain("\u00a51.23");
    expect(expanded).toContain("topped-up");
    expect(expanded).toContain("\u00a59.30");
  });

  test("unavailable DeepSeek access stays visible without losing balance data", () => {
    const fixture = { ...(deepseekFixture() as Record<string, unknown>), is_available: false };
    const provider = normalizeDeepseekBalance(fixture, nowMs());
    const view = providerToView(provider);

    expect(provider.status).toBe("partial");
    expect(provider.statusText).toBe("API access unavailable");
    expect(provider.windows[0]?.currentValue).toBe(10.53);
    expect(view.status).toBe("partial");
    expect(view.summary).toContain("API access unavailable");
    expect(view.metrics.some((metric) => metric.label === "balance")).toBe(true);
  });

  test("adapter reports missing auth without a credential", async () => {
    await withoutUsageEnv(async () => {
      const provider = await deepseekUsageAdapter.fetchUsage(makeCtx({}, {}), new AbortController().signal);
      expect(provider.status).toBe("missing-auth");
    });
  });

  test("adapter fetches balance with Bearer token", async () => {
    const captured = captureRequest(deepseekFixture());
    const provider = await deepseekUsageAdapter.fetchUsage(makeCtx({}, { DEEPSEEK_API_KEY: "ds-key" }), new AbortController().signal);
    expect(captured.url).toBe("https://api.deepseek.com/user/balance");
    expect(captured.headers.Authorization).toBe("Bearer ds-key");
    expect(provider.status).toBe("ready");
  });
});

describe("glm enterprise quota", () => {
  test("uses ?type=2 and Bigmodel headers when org+project configured via config", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, {}, { ...CONFIG_DEFAULTS, zai_organization_id: "org-1", zai_project_id: "proj-1" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
    expect(captured.headers.Authorization).toBe("zp");
    expect(captured.headers["Bigmodel-Organization"]).toBe("org-1");
    expect(captured.headers["Bigmodel-Project"]).toBe("proj-1");
  });

  test("uses ?type=2 when org+project provided via env", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, { ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toContain("?type=2");
    expect(captured.headers["Bigmodel-Organization"]).toBe("env-org");
    expect(captured.headers["Bigmodel-Project"]).toBe("env-proj");
  });

  test("config organization overrides env", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, { ZHIPU_ORGANIZATION_ID: "env-org", ZHIPU_PROJECT_ID: "env-proj" }, { ...CONFIG_DEFAULTS, zai_organization_id: "cfg-org", zai_project_id: "cfg-proj" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.headers["Bigmodel-Organization"]).toBe("cfg-org");
    expect(captured.headers["Bigmodel-Project"]).toBe("cfg-proj");
  });

  test("omits ?type=2 and Bigmodel headers when org/project absent", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect(captured.headers.Authorization).toBe("zp");
    expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
    expect(captured.headers["Bigmodel-Project"]).toBeUndefined();
  });

  test("omits ?type=2 when only organization is set", async () => {
    const captured = captureRequest(zaiFixture());
    const ctx = makeCtx({ zhipu: { token: "zp" } }, {}, { ...CONFIG_DEFAULTS, zai_organization_id: "org-1" });
    await zaiUsageAdapter.fetchUsage(ctx, new AbortController().signal);
    expect(captured.url).not.toContain("?type=2");
    expect(captured.headers["Bigmodel-Organization"]).toBeUndefined();
  });
});
