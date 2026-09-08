/// <reference types="bun" />

import { afterEach, describe, expect, test } from "bun:test";

import {
	normalizeOpenCodeGoUsage,
	opencodeGoProviderDefinition,
} from "../providers/opencode-go.js";
import { createCredentialResolver } from "../credentials.js";
import { captureRequest, restoreFetch } from "./_helpers.js";

afterEach(() => {
	restoreFetch();
});

describe("OpenCode Go provider", () => {
	test("normalizes rolling, weekly, and monthly usage", () => {
		const now = Date.parse("2026-09-03T00:00:00.000Z");
		const provider = normalizeOpenCodeGoUsage(
			{
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
						percent: 6,
						resetsAt: "2026-10-01T00:00:00.000Z",
					},
				},
			},
			now,
		);

		expect(provider.status).toBe("ready");
		expect(provider.fetchedAt).toBe(now);
		expect(
			provider.windows.map((window) => [
				window.label,
				window.kind,
				window.percentage,
			]),
		).toEqual([
			["5h", "rolling", 9],
			["week", "weekly", 100],
			["month", "monthly", 6],
		]);
		expect(provider.windows[0]?.period).toEqual({
			kind: "rolling",
			durationMs: 5 * 60 * 60 * 1000,
		});
		expect(provider.windows[1]?.period).toEqual({
			kind: "calendar",
			unit: "week",
		});
		expect(provider.windows[1]?.limitReached).toBe(true);
		expect(provider.windows[2]?.resetAt).toBe(
			Date.parse("2026-10-01T00:00:00.000Z"),
		);
		expect(provider.windows[2]?.period).toEqual({
			kind: "calendar",
			unit: "billing",
		});
	});

	test("returns partial data when a usage window is absent", () => {
		const provider = normalizeOpenCodeGoUsage({
			usage: {
				rolling: {
					status: "ok",
					percent: 12,
					resetsAt: "2026-09-03T04:30:00.000Z",
				},
			},
		});

		expect(provider.status).toBe("partial");
		expect(provider.statusText).toBe("partial data");
		expect(provider.windows).toHaveLength(1);
	});

	test("uses the OpenCode Go bearer credential", async () => {
		const captured = captureRequest({
			usage: {
				rolling: { status: "ok", percent: 1 },
				weekly: { status: "ok", percent: 2 },
				monthly: { status: "ok", percent: 3 },
			},
		});
		const parsed =
			opencodeGoProviderDefinition.registration.parseOptions({});
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const provider = await parsed.value.fetchUsage({
			credential: {
				secret: "go-api-key",
				source: "opencode",
				variant: "opencode-go",
				epoch: 1,
			},
			signal: new AbortController().signal,
			timeoutMs: 1000,
		});

		expect(provider.status).toBe("ready");
		expect(captured.url).toBe(
			"https://opencode.ai/zen/go/v1/usage",
		);
		expect(captured.headers.Authorization).toBe(
			"Bearer go-api-key",
		);
	});

	test("resolves the API key saved by OpenCode Go /connect", async () => {
		const reads: string[] = [];
		const resolution = await createCredentialResolver({
			readOpenCodeEntry: (entry) => {
				reads.push(`auth:${entry}`);
				return entry === "opencode-go" ? "go-api-key" : undefined;
			},
			readEnv: (name) => {
				reads.push(`env:${name}`);
				return undefined;
			},
		}).resolve(opencodeGoProviderDefinition.registration);

		expect(resolution).toMatchObject({
			ok: true,
			lease: {
				secret: "go-api-key",
				source: "opencode",
				variant: "opencode-go",
			},
		});
		expect(reads).toEqual(["auth:opencode-go"]);
	});
});
