import type { AuthEntry, AuthJson, AuthState } from "./providers/types.js";

const HOME = process.env.HOME ?? "";
const AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? "Invalid JSON";
}

export function extractToken(entry: AuthEntry | undefined): string | undefined {
  if (!entry) return undefined;
  return entry.key || entry.apiKey || entry.api_key || entry.token || entry.accessToken || entry.auth_token || entry.access || entry.refresh || undefined;
}

export async function readAuthFile(): Promise<AuthState> {
  const file = Bun.file(AUTH_PATH);
  if (!(await file.exists())) return { kind: "missing", path: AUTH_PATH };
  try {
    const parsed = JSON.parse(await file.text()) as AuthJson;
    return { kind: "loaded", path: AUTH_PATH, auth: parsed };
  } catch (error: unknown) {
    return { kind: "invalid", path: AUTH_PATH, error: shortError(error) };
  }
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

function asAuthEntry(value: unknown): AuthEntry | undefined {
  return value && typeof value === "object" ? value as AuthEntry : undefined;
}
