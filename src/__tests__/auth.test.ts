/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import {
	discoverDeepseekCredential,
	discoverOpenAICredential,
	discoverZaiCredential,
	extractToken,
	findOpenCodeAuthPaths,
	parseAuthJson,
	readAuthFile,
	readOpenCodeEntry,
} from "../auth.js";
import { withoutUsageEnv } from "./_helpers.js";

describe("auth discovery", () => {
	test.each([
		"null",
		"[]",
		'"auth"',
	])("rejects a non-object auth JSON top level", (text) => {
		expect(parseAuthJson(text, "/virtual/auth.json")).toEqual({
			kind: "invalid",
			path: "/virtual/auth.json",
			error: "OpenCode auth file is invalid",
		});
	});

	test("sanitizes auth entries to allowed correctly typed fields", () => {
		const state = parseAuthJson(
			JSON.stringify({
				deepseek: {
					key: "legacy-key",
					token: 42,
					expires: "tomorrow",
					accountId: "account-1",
					unknown: "remove-me",
				},
				invalid: "not-an-entry",
			}),
			"/virtual/auth.json",
		);

		expect(state).toEqual({
			kind: "loaded",
			path: "/virtual/auth.json",
			auth: { deepseek: { key: "legacy-key", accountId: "account-1" } },
		});
		if (state.kind !== "loaded") return;
		expect(discoverDeepseekCredential(state.auth, {})).toEqual({
			token: "legacy-key",
		});
	});

	test("discovers OpenCode auth candidates from XDG data before legacy config paths", () => {
		expect(
			findOpenCodeAuthPaths({
				home: "/home/tester",
				platform: "linux",
				env: { XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/config" },
			}),
		).toEqual([
			"/data/opencode/auth.json",
			"/home/tester/.local/share/opencode/auth.json",
			"/config/opencode/auth.json",
			"/home/tester/.config/opencode/auth.json",
			"/home/tester/.opencode/auth.json",
		]);
	});

	test("discovers Windows auth candidates from local app data before roaming app data", () => {
		expect(
			findOpenCodeAuthPaths({
				home: "C:/Users/tester",
				platform: "win32",
				env: { LOCALAPPDATA: "C:/Local", APPDATA: "C:/Roaming" },
			}),
		).toEqual([
			"C:/Local/opencode/auth.json",
			"C:/Roaming/opencode/auth.json",
			"C:/Users/tester/.opencode/auth.json",
		]);
	});

	test("ignores relative auth base paths from environment variables", () => {
		expect(
			findOpenCodeAuthPaths({
				home: "/home/tester",
				platform: "linux",
				env: { XDG_DATA_HOME: "relative-data", XDG_CONFIG_HOME: "relative-config" },
			}),
		).toEqual([
			"/home/tester/.local/share/opencode/auth.json",
			"/home/tester/.config/opencode/auth.json",
			"/home/tester/.opencode/auth.json",
		]);
		expect(
			findOpenCodeAuthPaths({
				home: "C:/Users/tester",
				platform: "win32",
				env: { LOCALAPPDATA: "relative-local", APPDATA: "relative-roaming" },
			}),
		).toEqual(["C:/Users/tester/.opencode/auth.json"]);
	});

	test("reads the first existing auth candidate and fails closed when it is invalid", async () => {
		const reads: string[] = [];
		const state = await readAuthFile({
			candidates: ["/missing/auth.json", "/bad/auth.json", "/good/auth.json"],
			readText: async (path) => {
				reads.push(path);
				if (path === "/missing/auth.json") return { exists: false };
				if (path === "/bad/auth.json") return { exists: true, text: "[]" };
				return {
					exists: true,
					text: JSON.stringify({ openai: { access: "secret" } }),
				};
			},
		});

		expect(state).toEqual({
			kind: "invalid",
			path: "/bad/auth.json",
			error: "OpenCode auth file is invalid",
		});
		expect(reads).toEqual(["/missing/auth.json", "/bad/auth.json"]);
		expect(JSON.stringify(state)).not.toContain("secret");
	});

	test("extractToken reads supported token field names", () => {
		expect(extractToken({ key: "a" })).toBe("a");
		expect(extractToken({ apiKey: "b" })).toBe("b");
		expect(extractToken({ api_key: "c" })).toBe("c");
		expect(extractToken({ token: "d" })).toBe("d");
		expect(extractToken({ accessToken: "e" })).toBe("e");
		expect(extractToken({ auth_token: "f" })).toBe("f");
		expect(extractToken({ refresh: "refresh-secret" })).toBeUndefined();
		expect(extractToken(undefined)).toBeUndefined();
	});

	test("OpenAI requires OpenCode OAuth account metadata while Z.AI supports env fallback", () => {
		withoutUsageEnv(() => {
			expect(
				discoverOpenAICredential(
					{
						openai: {
							access: "auth-openai",
							accountId: "account-1",
							type: "oauth",
							expires: Date.now() + 60_000,
						},
					},
					{ OPENAI_API_KEY: "env" },
				),
			).toMatchObject({ token: "auth-openai", accountId: "account-1" });
			expect(discoverOpenAICredential({}, { OPENAI_API_KEY: "env" })).toEqual({
				message: "auth missing",
			});
			expect(
				discoverOpenAICredential(
					{
						openai: {
							access: "auth-openai",
							accountId: "account-1",
							type: "api",
							expires: Date.now() + 60_000,
						},
					},
					{},
				),
			).toEqual({ message: "auth missing" });
			expect(
				discoverOpenAICredential(
					{
						openai: {
							access: "auth-openai",
							accountId: "account-1",
							type: "oauth",
							expires: Date.now() - 1,
						},
					},
					{},
				),
			).toEqual({ message: "auth missing" });
			expect(discoverOpenAICredential({}, {})).toEqual({
				message: "auth missing",
			});
			expect(
				discoverZaiCredential({ "zai-coding-plan": { key: "zai" } }, {}),
			).toEqual({ token: "zai", baseUrl: "https://api.z.ai" });
			expect(discoverZaiCredential({ zhipu: { token: "zp" } }, {})).toEqual({
				token: "zp",
				baseUrl: "https://open.bigmodel.cn",
			});
		});
	});

	test("OpenAI OpenCode entry rejects generic keys with spoofed nested OAuth metadata", async () => {
		const credential = await readOpenCodeEntry("openai", {
			candidates: ["/virtual/auth.json"],
			readText: async () => ({
				exists: true,
				text: JSON.stringify({
					openai: {
						key: "platform-api-key",
						metadata: {
							type: "oauth",
							accountId: "account-1",
							expires: String(Date.now() + 60_000),
						},
					},
				}),
			}),
		});

		expect(credential).toBeUndefined();
	});
});

describe("deepseek auth discovery", () => {
	test("prefers auth entry then env", () => {
		withoutUsageEnv(() => {
			expect(
				discoverDeepseekCredential(
					{ deepseek: { key: "auth-ds" } },
					{ DEEPSEEK_API_KEY: "env" },
				),
			).toEqual({ token: "auth-ds" });
			expect(
				discoverDeepseekCredential({}, { DEEPSEEK_API_KEY: "env" }),
			).toEqual({ token: "env" });
			expect(discoverDeepseekCredential({}, {})).toEqual({
				message: "auth missing",
			});
		});
	});
});
