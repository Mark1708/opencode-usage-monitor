/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import { createCredentialResolver } from "../credentials.js";
import {
	normalizeOpenCodeGoUsage,
	opencodeGoProviderDefinition,
} from "../providers/opencode-go.js";
import { providerToView } from "../views/index.js";
import { captureRequest, mockJsonResponse, restoreFetch } from "./_helpers.js";

const GO_USAGE_FIXTURE = {
	usage: {
		rolling: {
			status: "ok",
			percent: 9,
			resetsAt: "2026-09-03T04:30:00.000Z",
		},
		weekly: {
			status: "rate-limited",
			percent: 100,
			resetsAt: "2026-09-07T00:00:00.000Z",
		},
		monthly: {
			status: "ok",
			percent: 31,
			resetsAt: "2026-10-01T00:00:00.000Z",
		},
	},
} as const;

const NOW_MS = Date.parse("2026-09-03T00:00:00.000Z");

afterEach(() => {
	restoreFetch();
});

describe("OpenCode Go provider", () => {
	test("normalizes the official rolling, weekly, and monthly usage payload", () => {
		const provider = normalizeOpenCodeGoUsage(GO_USAGE_FIXTURE, NOW_MS);

		expect(provider).toMatchObject({
			id: "opencode-go",
			displayName: "OpenCode Go",
			status: "ready",
			fetchedAt: NOW_MS,
		});
		expect(
			provider.windows.map((window) => ({
				label: window.label,
				kind: window.kind,
				percentage: window.percentage,
				limitReached: window.limitReached,
			})),
		).toEqual([
			{ label: "5h", kind: "rolling", percentage: 9, limitReached: undefined },
			{ label: "week", kind: "weekly", percentage: 100, limitReached: true },
			{ label: "month", kind: "monthly", percentage: 31, limitReached: undefined },
		]);
		expect(provider.windows[0]?.period).toEqual({
			kind: "rolling",
			durationMs: 5 * 60 * 60 * 1000,
		});
		expect(provider.windows[1]?.period).toEqual({
			kind: "calendar",
			unit: "week",
		});
		expect(provider.windows[2]?.period).toEqual({
			kind: "calendar",
			unit: "billing",
		});
		expect(providerToView(provider).metrics.map((metric) => metric.label)).toEqual([
			"5h",
			"week",
			"month",
		]);
	});

	test("returns partial data when the API omits a usage window", () => {
		const provider = normalizeOpenCodeGoUsage({
			usage: { rolling: GO_USAGE_FIXTURE.usage.rolling },
		}, NOW_MS);

		expect(provider.status).toBe("partial");
		expect(provider.statusText).toBe("partial data");
		expect(provider.windows.map((window) => window.label)).toEqual(["5h"]);
	});

	test("fetches usage with the OpenCode Go bearer credential", async () => {
		const captured = captureRequest(GO_USAGE_FIXTURE);
		const provider = await fetchUsage();

		expect(provider.status).toBe("ready");
		expect(captured.url).toBe("https://opencode.ai/zen/go/v1/usage");
		expect(captured.headers.Authorization).toBe("Bearer go-api-key");
		expect(captured.headers.Accept).toBe("application/json");
	});

	test.each([401, 403])("maps API status %d to forbidden", async (status) => {
		mockJsonResponse({}, status);
		expect(await fetchUsage()).toMatchObject({
			status: "forbidden",
			statusText: "forbidden",
		});
	});

	test("maps a request timeout without exposing the credential", async () => {
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init?.signal?.addEventListener("abort", () => reject(new Error("go-api-key aborted")), {
				once: true,
			});
			return promise;
		}) as typeof fetch;

		const provider = await fetchUsage(1);
		expect(provider).toMatchObject({ status: "error", statusText: "timeout" });
		expect(JSON.stringify(provider)).not.toContain("go-api-key");
	});

	test("prefers the stored opencode-go credential over the explicit environment fallback", async () => {
		const reads: string[] = [];
		const resolver = createCredentialResolver({
			readOpenCodeEntry: (entry) => {
				reads.push(`auth:${entry}`);
				return entry === "opencode-go" ? "stored-go-key" : undefined;
			},
			readEnv: (name) => {
				reads.push(`env:${name}`);
				return "environment-go-key";
			},
		});

		const resolution = await resolver.resolve(opencodeGoProviderDefinition.registration);
		expect(resolution).toMatchObject({
			ok: true,
			lease: {
				secret: "stored-go-key",
				source: "opencode",
				variant: "opencode-go",
			},
		});
		expect(reads).toEqual(["auth:opencode-go"]);
	});

	test("uses only OPENCODE_GO_API_KEY as the automatic environment fallback", async () => {
		const reads: string[] = [];
		const resolver = createCredentialResolver({
			readOpenCodeEntry: (entry) => {
				reads.push(`auth:${entry}`);
				return undefined;
			},
			readEnv: (name) => {
				reads.push(`env:${name}`);
				return name === "OPENCODE_GO_API_KEY" ? "environment-go-key" : undefined;
			},
		});

		const resolution = await resolver.resolve(opencodeGoProviderDefinition.registration);
		expect(resolution).toMatchObject({
			ok: true,
			lease: {
				secret: "environment-go-key",
				source: "env",
				variant: "opencode-go",
			},
		});
		expect(reads).toEqual(["auth:opencode-go", "env:OPENCODE_GO_API_KEY"]);
	});
});

async function fetchUsage(timeoutMs = 1000) {
	const parsed = opencodeGoProviderDefinition.registration.parseOptions({});
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) throw new Error("OpenCode Go options did not parse");
	return parsed.value.fetchUsage({
		credential: {
			secret: "go-api-key",
			source: "opencode",
			variant: "opencode-go",
			epoch: 1,
		},
		signal: new AbortController().signal,
		timeoutMs,
	});
}
