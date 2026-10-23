/// <reference types="bun" />
import { afterEach, describe, expect, test } from "bun:test";
import { grokProviderDefinition, normalizeGrokUsage } from "../providers/grok.js";
import { createCredentialResolver } from "../credentials.js";
import { parseUsageConfigV2 } from "../runtime-config.js";
import { validateAndCloneUsageSnapshot } from "../snapshot-validation.js";
import { captureRequest, mockJsonResponse, restoreFetch } from "./_helpers.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
// Synthetic fixture matching the observed live response; contains no account data.
const CONFIG = {
	currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-22T00:00:00Z", end: "2026-10-29T00:00:00Z" },
	onDemandCap: { val: 0 }, onDemandUsed: { val: 0 }, prepaidBalance: { val: 0 }, isUnifiedBillingUser: true,
};
afterEach(restoreFetch);

describe("Grok subscription usage", () => {
	test("can be enabled explicitly without enabling other providers", () => {
		const result = parseUsageConfigV2({ version: 2, providers: { grok: {} } });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.providers.map((provider) => provider.id)).toEqual(["grok"]);
	});
	test.each([undefined, 25])("publishes a canonical snapshot without raw provider fields (%s)", (creditUsagePercent) => {
		const snapshot = normalizeGrokUsage({ config: { ...CONFIG, ...(creditUsagePercent === undefined ? {} : { creditUsagePercent }), privateAccount: "must-not-publish" } }, NOW);
		expect(validateAndCloneUsageSnapshot(snapshot, "grok").ok).toBe(true);
		expect(JSON.stringify(snapshot)).not.toContain("must-not-publish");
	});
	test("resolves only the stored xai credential without environment fallback", async () => {
		const reads: string[] = [];
		const resolver = createCredentialResolver({
			readOpenCodeEntry: (entry) => { reads.push(entry); return undefined; },
			readEnv: () => { throw new Error("must not read environment"); },
		});
		expect(await resolver.resolve(grokProviderDefinition.registration)).toMatchObject({ ok: false, kind: "missing" });
		expect(reads).toEqual(["xai"]);
		resolver.dispose();
	});
	test("normalizes an explicit weekly percentage and reset", () => {
		const result = normalizeGrokUsage({ config: { ...CONFIG, creditUsagePercent: 42.5 } }, NOW);
		expect(result.status).toBe("ready");
		expect(result.windows[0]).toMatchObject({ percentage: 42.5, period: { kind: "calendar", unit: "week" }, resetAt: Date.parse(CONFIG.currentPeriod.end) });
	});
	test("recognizes the omitted zero percentage verified against the live usage UI", () => {
		const result = normalizeGrokUsage({ config: CONFIG }, NOW);
		expect(result.status).toBe("ready");
		expect(result.windows[0]).toMatchObject({ percentage: 0, resetAt: Date.parse(CONFIG.currentPeriod.end) });
	});
	test("does not invent zero usage without the unified billing marker", () => {
		const result = normalizeGrokUsage({ config: { ...CONFIG, isUnifiedBillingUser: false } }, NOW);
		expect(result).toMatchObject({ status: "partial", statusText: "usage unavailable", windows: [] });
		expect(result.details?.map((detail) => detail.key)).toEqual(["reset", "prepaid"]);
	});
	test.each([
		{},
		{ type: "USAGE_PERIOD_TYPE_WEEKLY", start: "bad", end: CONFIG.currentPeriod.end },
		{ type: "USAGE_PERIOD_TYPE_WEEKLY", start: CONFIG.currentPeriod.end, end: CONFIG.currentPeriod.start },
		{ type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-01T00:00:00Z", end: "2026-10-08T00:00:00Z" },
		{ type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-11-01T00:00:00Z", end: "2026-11-08T00:00:00Z" },
		{ type: "unknown", start: CONFIG.currentPeriod.start, end: CONFIG.currentPeriod.end },
	])("does not infer zero from an unvalidated or inactive period %s", (currentPeriod) => {
		expect(normalizeGrokUsage({ config: { ...CONFIG, currentPeriod } }, NOW).windows).toEqual([]);
	});
	test.each([null, "5", -1, 101, Number.NaN, Infinity])("rejects invalid percent %s", (creditUsagePercent) => {
		expect(normalizeGrokUsage({ config: { ...CONFIG, creditUsagePercent } }, NOW).windows).toEqual([]);
	});
	test.each([0, 100])("retains explicit percent %d", (creditUsagePercent) => {
		expect(normalizeGrokUsage({ config: { ...CONFIG, creditUsagePercent } }, NOW).windows[0]?.percentage).toBe(creditUsagePercent);
	});
	test("maps monthly periods without guessing from time left", () => {
		const result = normalizeGrokUsage({ config: { creditUsagePercent: 12, currentPeriod: {
			type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z",
		} } }, NOW);
		expect(result.windows[0]?.period).toEqual({ kind: "calendar", unit: "billing" });
	});
	test("does not borrow a reset from a different period", () => {
		const result = normalizeGrokUsage({ config: { creditUsagePercent: 5, currentPeriod: { start: CONFIG.currentPeriod.start }, billingPeriodEnd: CONFIG.currentPeriod.end } }, NOW);
		expect(result.windows[0]?.resetAt).toBeUndefined();
		expect(result.windows[0]?.period).toEqual({ kind: "unknown" });
	});
	test("converts prepaid cents separately and ignores on-demand quota ratios", () => {
		const result = normalizeGrokUsage({ config: { ...CONFIG, isUnifiedBillingUser: false, prepaidBalance: { val: "1250" }, onDemandCap: { val: 100 }, onDemandUsed: { val: 50 } } }, NOW);
		expect(result.windows).toEqual([]);
		expect(result.details?.find((detail) => detail.key === "prepaid")?.value).toEqual({ kind: "currency", value: 12.5, currency: "USD" });
	});
	test.each([null, {}, { config: null }])("handles malformed response %s", (raw) => {
		expect(normalizeGrokUsage(raw, NOW)).toMatchObject({ status: "partial", windows: [] });
	});
	test("uses xAI OAuth and the CLI billing headers", async () => {
		const captured = captureRequest({ config: { ...CONFIG, creditUsagePercent: 7 } });
		expect((await fetchUsage()).status).toBe("ready");
		expect(captured.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
		expect(captured.headers.Authorization).toBe("Bearer grok-test-token");
		expect(captured.headers["X-XAI-Token-Auth"]).toBe("xai-grok-cli");
	});
	test.each([401, 403])("maps HTTP %d to forbidden", async (status) => {
		mockJsonResponse({}, status);
		expect(await fetchUsage()).toMatchObject({ status: "forbidden" });
	});
	test("rejects expired and API-key credentials before network work", async () => {
		let calls = 0;
		globalThis.fetch = Object.assign(async (_input: RequestInfo | URL): Promise<Response> => { calls++; throw new Error("must not fetch"); }, { preconnect: globalThis.fetch.preconnect });
		expect(await fetchUsage({ type: "oauth", expires: "1" })).toMatchObject({ statusText: "oauth expired" });
		expect(await fetchUsage({ type: "key" })).toMatchObject({ statusText: "oauth missing" });
		expect(calls).toBe(0);
	});
	test("redacts credentials from network errors", async () => {
		globalThis.fetch = Object.assign(async (_input: RequestInfo | URL): Promise<Response> => { throw new Error("grok-test-token failed"); }, { preconnect: globalThis.fetch.preconnect });
		expect(JSON.stringify(await fetchUsage())).not.toContain("grok-test-token");
	});
	test("maps timeout and cancellation without exposing the credential", async () => {
		globalThis.fetch = Object.assign((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new Error("grok-test-token aborted")), { once: true });
		}), { preconnect: globalThis.fetch.preconnect });
		const parsed = grokProviderDefinition.registration.parseOptions({});
		if (!parsed.ok) throw new Error("invalid options");
		const controller = new AbortController();
		const context = { credential: { secret: "grok-test-token", source: "opencode" as const, variant: "grok", epoch: 1, metadata: { type: "oauth", expires: String(Date.now() + 60_000) } }, signal: controller.signal, timeoutMs: 1 };
		expect(await parsed.value.fetchUsage(context)).toMatchObject({ statusText: "timeout" });
		const request = parsed.value.fetchUsage({ ...context, timeoutMs: 1000 });
		controller.abort();
		expect(await request).toMatchObject({ statusText: "cancelled" });
	});
});

async function fetchUsage(metadata: Readonly<Record<string, string>> = { type: "oauth", expires: String(Date.now() + 60_000) }) {
	const parsed = grokProviderDefinition.registration.parseOptions({});
	if (!parsed.ok) throw new Error("invalid options");
	return parsed.value.fetchUsage({ credential: { secret: "grok-test-token", source: "opencode", variant: "grok", epoch: 1, metadata }, signal: new AbortController().signal, timeoutMs: 1000 });
}
