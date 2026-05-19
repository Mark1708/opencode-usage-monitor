import type { AuthEntry, AuthJson, AuthState, DiscoveredProvider, ProviderId } from "./types.js";

const HOME = process.env.HOME ?? "";
const AUTH_PATH = `${HOME}/.local/share/opencode/auth.json`;
const OMO_CONFIG_PATH = `${HOME}/.config/opencode/oh-my-openagent.json`;

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
  auth: AuthJson,
): { token: string } | { message: string } {
  // 1. auth.json openai entry -> access field (OAuth token)
  const openai = auth.openai;
  if (openai && typeof openai === "object") {
    const accessToken = openai.access;
    if (typeof accessToken === "string" && accessToken.length > 0) {
      return { token: accessToken };
    }
  }

  // 2. OPENAI_API_KEY env var
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return { token: apiKey };

  return { message: "auth missing" };
}

type ZaiBaseUrl = "https://api.z.ai" | "https://open.bigmodel.cn";

interface ZaiCredentialSuccess {
  token: string;
  baseUrl: ZaiBaseUrl;
}

type ZaiCredential = ZaiCredentialSuccess | { message: string };

export function discoverZaiCredential(auth: AuthJson): ZaiCredential {
  // 1. auth.json "zai-coding-plan"
  const zaiCodingPlan = extractToken(auth["zai-coding-plan"]);
  if (zaiCodingPlan) return { token: zaiCodingPlan, baseUrl: "https://api.z.ai" };

  // 2. auth.json "zai"
  const zai = extractToken(auth.zai);
  if (zai) return { token: zai, baseUrl: "https://api.z.ai" };

  // 3. auth.json "zhipu"
  const zhipu = extractToken(auth.zhipu);
  if (zhipu) return { token: zhipu, baseUrl: "https://open.bigmodel.cn" };

  // 4. ZAI_API_KEY
  const zaiEnv = process.env.ZAI_API_KEY;
  if (zaiEnv) return { token: zaiEnv, baseUrl: "https://api.z.ai" };

  // 5. ZAI_CODING_PLAN_API_KEY
  const zaiCodingPlanEnv = process.env.ZAI_CODING_PLAN_API_KEY;
  if (zaiCodingPlanEnv) return { token: zaiCodingPlanEnv, baseUrl: "https://api.z.ai" };

  // 6. ZHIPU_API_KEY
  const zhipuEnv = process.env.ZHIPU_API_KEY;
  if (zhipuEnv) return { token: zhipuEnv, baseUrl: "https://open.bigmodel.cn" };

  // 7. ZHIPUAI_API_KEY
  const zhipuaiEnv = process.env.ZHIPUAI_API_KEY;
  if (zhipuaiEnv) return { token: zhipuaiEnv, baseUrl: "https://open.bigmodel.cn" };

  return { message: "auth missing" };
}

function extractProviderPrefix(modelRef: string): string {
  const slash = modelRef.indexOf("/");
  return slash === -1 ? "" : modelRef.slice(0, slash);
}

const KNOWN_PREFIXES = new Set<string>(["openai", "zai-coding-plan", "zai", "zhipu"]);

function collectPrefixes(config: Record<string, unknown>): Set<string> {
  const prefixes = new Set<string>();
  const agents = config.agents;
  if (agents && typeof agents === "object" && agents !== null) {
    for (const agentConfig of Object.values(agents as Record<string, Record<string, unknown>>)) {
      if (typeof agentConfig.model === "string") {
        const prefix = extractProviderPrefix(agentConfig.model);
        if (prefix && KNOWN_PREFIXES.has(prefix)) prefixes.add(prefix);
      }
      const fallbacks = agentConfig.fallback_models;
      if (Array.isArray(fallbacks)) {
        for (const fb of fallbacks) {
          if (fb && typeof fb === "object" && typeof fb.model === "string") {
            const prefix = extractProviderPrefix(fb.model);
            if (prefix && KNOWN_PREFIXES.has(prefix)) prefixes.add(prefix);
          }
        }
      }
    }
  }
  const categories = config.categories;
  if (categories && typeof categories === "object" && categories !== null) {
    for (const catConfig of Object.values(categories as Record<string, Record<string, unknown>>)) {
      if (typeof catConfig.model === "string") {
        const prefix = extractProviderPrefix(catConfig.model);
        if (prefix && KNOWN_PREFIXES.has(prefix)) prefixes.add(prefix);
      }
      const fallbacks = catConfig.fallback_models;
      if (Array.isArray(fallbacks)) {
        for (const fb of fallbacks) {
          if (fb && typeof fb === "object" && typeof fb.model === "string") {
            const prefix = extractProviderPrefix(fb.model);
            if (prefix && KNOWN_PREFIXES.has(prefix)) prefixes.add(prefix);
          }
        }
      }
    }
  }
  return prefixes;
}

function prefixToProviderId(prefix: string): ProviderId | null {
  if (prefix === "openai") return "openai";
  if (prefix === "zai-coding-plan" || prefix === "zai" || prefix === "zhipu") return "zai";
  return null;
}

export async function discoverProviders(auth: AuthJson): Promise<DiscoveredProvider[]> {
  const providers: DiscoveredProvider[] = [];
  const seen = new Set<ProviderId>();

  // Always check credentials directly
  const openaiCred = discoverOpenAICredential(auth);
  if ("token" in openaiCred) {
    providers.push({ id: "openai", hasAuth: true });
    seen.add("openai");
  }

  const zaiCred = discoverZaiCredential(auth);
  if ("token" in zaiCred) {
    providers.push({ id: "zai", hasAuth: true });
    seen.add("zai");
  }

  // Also check oh-my-openagent.json for model references
  try {
    const file = Bun.file(OMO_CONFIG_PATH);
    if (await file.exists()) {
      const config = JSON.parse(await file.text()) as Record<string, unknown>;
      const prefixes = collectPrefixes(config);
      for (const prefix of prefixes) {
        const providerId = prefixToProviderId(prefix);
        if (providerId && !seen.has(providerId)) {
          providers.push({
            id: providerId,
            hasAuth: false,
            authMessage: "auth missing",
          });
          seen.add(providerId);
        }
      }
    }
  } catch {
    // Invalid oh-my-openagent.json — ignore, plugin still works
  }

  return providers;
}
