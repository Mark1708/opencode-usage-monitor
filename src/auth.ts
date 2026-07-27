import { homedir } from "node:os";
import type { AuthEntry, AuthJson, AuthState } from "./providers/types.js";

const HOME = homedir() ?? "";
const AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;
const AUTH_STRING_FIELDS = [
  "type", "key", "apiKey", "api_key", "token", "accessToken", "auth_token",
  "access", "refresh", "accountId",
] as const;

export function extractToken(entry: AuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.key || entry.apiKey || entry.api_key || entry.token || entry.accessToken || entry.auth_token || entry.access || entry.refresh || undefined;
}

export async function readAuthFile(): Promise<AuthState> {
  const file = Bun.file(AUTH_PATH);
  if (!(await file.exists())) return { kind: "missing", path: AUTH_PATH };
  try {
    return parseAuthJson(await file.text(), AUTH_PATH);
  } catch (_error: unknown) {
    return invalidAuthState(AUTH_PATH);
  }
}

export function parseAuthJson(text: string, path: string): AuthState {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) return invalidAuthState(path);
    return { kind: "loaded", path, auth: sanitizeAuthJson(parsed) };
  } catch (_error: unknown) {
    return invalidAuthState(path);
  }
}

export async function readOpenCodeEntry(entry: string): Promise<string | undefined> {
  const state = await readAuthFile();
  if (state.kind === "missing") return undefined;
  if (state.kind === "invalid") throw new Error("OpenCode auth file is invalid");
  return extractToken(asAuthEntry(state.auth[entry]));
}

export function discoverOpenAICredential(
  auth: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): { token: string } | { message: string } {
  const openai = asAuthEntry(auth.openai);
  const accessToken = openai?.access;
  if (typeof accessToken === "string" && accessToken.length > 0) {
    return { token: accessToken };
  }

  const apiKey = env.OPENAI_API_KEY;
  if (apiKey) return { token: apiKey };

  return { message: "auth missing" };
}

export function discoverDeepseekCredential(
  auth: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): { token: string } | { message: string } {
  const deepseek = extractToken(asAuthEntry(auth.deepseek));
  if (deepseek) return { token: deepseek };

  const apiKey = env.DEEPSEEK_API_KEY;
  if (apiKey) return { token: apiKey };

  return { message: "auth missing" };
}

type ZaiBaseUrl = "https://api.z.ai" | "https://open.bigmodel.cn";

interface ZaiCredentialSuccess {
  token: string;
  baseUrl: ZaiBaseUrl;
}

type ZaiCredential = ZaiCredentialSuccess | { message: string };

export function discoverZaiCredential(auth: Record<string, unknown>, env: Record<string, string | undefined> = process.env): ZaiCredential {
  const zaiCodingPlan = extractToken(asAuthEntry(auth["zai-coding-plan"]));
  if (zaiCodingPlan) return { token: zaiCodingPlan, baseUrl: "https://api.z.ai" };

  const zai = extractToken(asAuthEntry(auth.zai));
  if (zai) return { token: zai, baseUrl: "https://api.z.ai" };

  const zhipu = extractToken(asAuthEntry(auth.zhipu));
  if (zhipu) return { token: zhipu, baseUrl: "https://open.bigmodel.cn" };

  const zaiEnv = env.ZAI_API_KEY;
  if (zaiEnv) return { token: zaiEnv, baseUrl: "https://api.z.ai" };

  const zaiCodingPlanEnv = env.ZAI_CODING_PLAN_API_KEY;
  if (zaiCodingPlanEnv) return { token: zaiCodingPlanEnv, baseUrl: "https://api.z.ai" };

  const zhipuEnv = env.ZHIPU_API_KEY;
  if (zhipuEnv) return { token: zhipuEnv, baseUrl: "https://open.bigmodel.cn" };

  const zhipuaiEnv = env.ZHIPUAI_API_KEY;
  if (zhipuaiEnv) return { token: zhipuaiEnv, baseUrl: "https://open.bigmodel.cn" };

  return { message: "auth missing" };
}

function sanitizeAuthJson(value: Record<string, unknown>): AuthJson {
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const sanitized = sanitizeAuthEntry(entry);
    return sanitized ? [[key, sanitized]] : [];
  }));
}

function sanitizeAuthEntry(value: unknown): AuthEntry | undefined {
  if (!isPlainObject(value)) return undefined;
  const strings = AUTH_STRING_FIELDS.flatMap((field) => (
    typeof value[field] === "string" ? [[field, value[field]]] : []
  ));
  const expires = typeof value.expires === "number" && Number.isFinite(value.expires)
    ? [["expires", value.expires]]
    : [];
  return Object.fromEntries([...strings, ...expires]);
}

function asAuthEntry(value: unknown): AuthEntry | undefined {
  return sanitizeAuthEntry(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidAuthState(path: string): AuthState {
  return { kind: "invalid", path, error: "OpenCode auth file is invalid" };
}
