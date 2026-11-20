/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { validateAndCloneUsageSnapshot } from "../snapshot-validation.js";
import { normalizeZaiQuota, normalizeZaiResets, zaiProviderDefinition } from "../providers/zai.js";
import { renderedMetrics, restoreFetch } from "./_helpers.js";

afterEach(() => {
  restoreFetch();
});

// Synthetic fixtures mirroring the observed live payload shapes.
const QUOTA = {
  code: 200,
  msg: "Operation successful",
  success: true,
  data: {
    level: "lite",
    limits: [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 2000, currentValue: 349, remaining: 1650, percentage: 17, nextResetTime: 1_795_219_293_938 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 10000, currentValue: 4491, remaining: 5508, percentage: 44, nextResetTime: 1_795_413_871_983 },
    ],
  },
} as const;

const card = (recordId: number, expireTime: string, available: boolean) => ({
  recordId,
  grantType: "GLOBAL",
  expireTime,
  available,
});

const resetsPayload = (fiveHourResets: unknown[], weekResets: unknown[]) => ({
  code: 200,
  msg: "Operation successful",
  success: true,
  data: { targetType: "PERSONAL", fiveHourResets, weekResets },
});

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const EXPIRY = "2026-12-22 23:59:59";

// Render a wall-clock string that Z.AI (UTC+8) would parse to targetMs.
function expiryAfter(offsetMs: number, nowMs: number): string {
  return new Date(nowMs + offsetMs + 8 * 3_600_000).toISOString().replace("T", " ").slice(0, 19);
}

describe("Z.AI quota reset cards", () => {
  test("maps available cards to an OpenAI-style resets summary with nearest expiry", () => {
    const provider = normalizeZaiQuota(
      QUOTA,
      "https://api.z.ai",
      NOW,
      resetsPayload([], [card(9, EXPIRY, true), card(10, EXPIRY, true), card(11, EXPIRY, true)]),
    );

    expect(provider.status).toBe("ready");
    expect(provider.windows.map((window) => window.label)).toEqual(["5h", "week"]);
    const resets = provider.details?.find((detail) => detail.key === "resets");
    expect(resets?.value).toEqual({ kind: "text", value: "3 · expires 32d" });
    expect(resets).toMatchObject({ visibility: "summary", tone: "normal" });
    const week = provider.details?.find((detail) => detail.key === "resets-week");
    expect(week?.value).toEqual({ kind: "text", value: "3 · expires 2026-12-22" });
    expect(provider.details?.find((detail) => detail.key === "resets-5h")).toBeUndefined();
  });

  test("keeps the resets row in the collapsed provider summary", () => {
    const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsPayload([], [card(1, EXPIRY, true)]));
    const rendered = renderedMetrics(provider);
    expect(rendered).toContain("44%");
    expect(rendered).toMatch(/resets\s+1/);
  });

  test.each([
    [25 * 3_600_000, "normal"],
    [24 * 3_600_000, "warn"],
    [2 * 3_600_000, "bad"],
  ] as const)("colors the summary by remaining time (%s -> %s)", (offset, tone) => {
    const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsPayload([], [card(1, expiryAfter(offset, NOW), true)]));
    expect(provider.details?.find((detail) => detail.key === "resets")).toMatchObject({ tone });
  });

  test("ignores unavailable and already expired cards", () => {
    const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsPayload(
      [card(1, EXPIRY, false), card(2, EXPIRY, true)],
      [card(3, expiryAfter(-86_400_000, NOW), true), card(4, EXPIRY, true)],
    ));

    expect(provider.details?.find((detail) => detail.key === "resets")?.value).toEqual({ kind: "text", value: "2 · expires 32d" });
    expect(provider.details?.find((detail) => detail.key === "resets-5h")?.value).toEqual({ kind: "text", value: "1 · expires 2026-12-22" });
  });

  test("counts cards with malformed expiry dates without inventing an expiry", () => {
    const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsPayload(
      [],
      [card(1, "not-a-date", true), card(2, EXPIRY, true)],
    ));

    expect(provider.details?.find((detail) => detail.key === "resets")?.value).toEqual({ kind: "text", value: "2 · expires 32d" });
  });

  test("omits reset rows for missing arrays, foreign payloads, or no resets request", () => {
    for (const resetsRaw of [resetsPayload([], []), { data: { targetType: "PERSONAL" } }, { code: 500 }, undefined]) {
      const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsRaw);
      expect(provider.status).toBe("ready");
      expect(provider.details?.find((detail) => detail.key === "resets")).toBeUndefined();
    }
  });

  test("publishes a canonical snapshot containing reset details", () => {
    const provider = normalizeZaiQuota(QUOTA, "https://api.z.ai", NOW, resetsPayload([card(1, EXPIRY, true)], [card(2, EXPIRY, true)]));
    expect(validateAndCloneUsageSnapshot(provider, "zai").ok).toBe(true);
    expect(JSON.stringify(provider)).not.toContain("recordId");
  });

  test("accepts and defaults the show_resets option", () => {
    expect(zaiProviderDefinition.parseOptions({})).toMatchObject({ ok: true, value: { show_resets: true } });
    expect(zaiProviderDefinition.parseOptions({ show_resets: false })).toMatchObject({ ok: true, value: { show_resets: false } });
    expect(zaiProviderDefinition.parseOptions({ show_resets: "false" })).toEqual({
      ok: false,
      issues: [{ path: "show_resets", message: "must be a boolean" }],
    });
  });

  test("fetches the personal reset inventory with the raw credential after the quota", async () => {
    const { urls } = mockRouter([
      { match: "/api/monitor/usage/quota/limit", body: QUOTA },
      { match: "/api/biz/customer-package-reset/list", body: resetsPayload([], [card(9, EXPIRY, true)]) },
    ]);

    const provider = await fetchZai({});

    expect(provider.details?.find((detail) => detail.key === "resets")).toMatchObject({ value: { kind: "text", value: "1 · expires 32d" } });
    expect(urls).toEqual([
      "https://api.z.ai/api/monitor/usage/quota/limit",
      "https://api.z.ai/api/biz/customer-package-reset/list?targetType=PERSONAL",
    ]);
  });

  test("skips the reset inventory for enterprise plans and show_resets: false", async () => {
    for (const options of [
      { plan: "enterprise", organization_id: "org-1", project_id: "project-1" },
      { show_resets: false },
    ]) {
      const { urls } = mockRouter([{ match: "/api/monitor/usage/quota/limit", body: QUOTA }]);
      const provider = await fetchZai(options);
      expect(urls.length).toBe(1);
      expect(urls[0]).toContain("/api/monitor/usage/quota/limit");
      expect(provider.details?.find((detail) => detail.key === "resets")).toBeUndefined();
    }
  });

  test("a failed reset inventory request only drops the reset rows", async () => {
    mockRouter([
      { match: "/api/monitor/usage/quota/limit", body: QUOTA },
      { match: "/api/biz/customer-package-reset/list", body: {}, status: 500 },
    ]);

    const provider = await fetchZai({});
    expect(provider).toMatchObject({ status: "ready" });
    expect(provider.windows.map((window) => window.label)).toEqual(["5h", "week"]);
    expect(provider.details?.find((detail) => detail.key === "resets")).toBeUndefined();
  });

  test("uses the zhipu base URL for the reset inventory", async () => {
    const { urls } = mockRouter([
      { match: "/api/monitor/usage/quota/limit", body: QUOTA },
      { match: "/api/biz/customer-package-reset/list", body: resetsPayload([], []) },
    ]);

    await fetchZai({}, "zhipu");
    expect(urls[1]).toBe("https://open.bigmodel.cn/api/biz/customer-package-reset/list?targetType=PERSONAL");
  });

  test("cancellation during the reset inventory stays terminal", async () => {
    mockRouter([
      { match: "/api/monitor/usage/quota/limit", body: QUOTA },
      {
        match: "/api/biz/customer-package-reset/list",
        stall: (init) => new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) {
            reject(new Error("zai-key aborted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("zai-key aborted")), { once: true });
        }),
      },
    ]);

    const parsed = zaiProviderDefinition.registration.parseOptions({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("invalid options");
    const caller = new AbortController();
    const provider = parsed.value.fetchUsage({
      credential: { secret: "zai-key", source: "opencode", variant: "zai", epoch: 1 },
      signal: caller.signal,
      timeoutMs: 5000,
    });
    caller.abort();
    expect(await provider).toMatchObject({ status: "error", statusText: "cancelled" });
  });
});

type Route = Readonly<{
  match: string;
  body?: unknown;
  status?: number;
  stall?: (init?: RequestInit) => Promise<Response>;
}>;

function mockRouter(routes: readonly Route[]): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) return new Response(JSON.stringify({ code: 200, msg: "unrouted", data: {} }), { status: 200 });
    if (route.stall) return route.stall(init);
    return new Response(JSON.stringify(route.body ?? {}), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { urls };
}

async function fetchZai(options: unknown, variant: "zai" | "zhipu" = "zai") {
  const parsed = zaiProviderDefinition.registration.parseOptions(options);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("invalid options");
  return parsed.value.fetchUsage({
    credential: { secret: "zai-key", source: "opencode", variant, epoch: 1 },
    signal: new AbortController().signal,
    timeoutMs: 1000,
  });
}
