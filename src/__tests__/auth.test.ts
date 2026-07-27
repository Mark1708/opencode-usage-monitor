/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { discoverDeepseekCredential, discoverOpenAICredential, discoverZaiCredential, extractToken } from "../auth.js";
import { withoutUsageEnv } from "./_helpers.js";

describe("auth discovery", () => {
  test("extractToken reads supported token field names", () => {
    expect(extractToken({ key: "a" })).toBe("a");
    expect(extractToken({ apiKey: "b" })).toBe("b");
    expect(extractToken({ api_key: "c" })).toBe("c");
    expect(extractToken({ token: "d" })).toBe("d");
    expect(extractToken({ accessToken: "e" })).toBe("e");
    expect(extractToken({ auth_token: "f" })).toBe("f");
    expect(extractToken(undefined)).toBeUndefined();
  });

  test("OpenAI and Z.AI credentials prefer auth entries and support env fallback", () => {
    withoutUsageEnv(() => {
      expect(discoverOpenAICredential({ openai: { access: "auth-openai" } }, { OPENAI_API_KEY: "env" })).toEqual({ token: "auth-openai" });
      expect(discoverOpenAICredential({}, { OPENAI_API_KEY: "env" })).toEqual({ token: "env" });
      expect(discoverOpenAICredential({}, {})).toEqual({ message: "auth missing" });
      expect(discoverZaiCredential({ "zai-coding-plan": { key: "zai" } }, {})).toEqual({ token: "zai", baseUrl: "https://api.z.ai" });
      expect(discoverZaiCredential({ zhipu: { token: "zp" } }, {})).toEqual({ token: "zp", baseUrl: "https://open.bigmodel.cn" });
    });
  });
});

describe("deepseek auth discovery", () => {
  test("prefers auth entry then env", () => {
    withoutUsageEnv(() => {
      expect(discoverDeepseekCredential({ deepseek: { key: "auth-ds" } }, { DEEPSEEK_API_KEY: "env" })).toEqual({ token: "auth-ds" });
      expect(discoverDeepseekCredential({}, { DEEPSEEK_API_KEY: "env" })).toEqual({ token: "env" });
      expect(discoverDeepseekCredential({}, {})).toEqual({ message: "auth missing" });
    });
  });
});
