import { discoverDeepseekCredential } from "../auth.js";
import { sanitizeAdditionalProperties, sanitizeCredentialError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { deepseekProviderToView } from "../views/deepseek-view.js";
import {
  defineProvider,
  LegacyAdapterFacade,
  type LegacyProviderBridge,
  type ProviderFetchContext,
  type ValidationIssue,
  type ValidationResult,
} from "./contracts.js";
import { asRecord, createStatusProvider, createTimeoutController, readString, slug } from "./shared.js";
import type { ProviderContext, StandardUsageProvider, StandardUsageWindow } from "./types.js";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const statusProvider = createStatusProvider("deepseek", "deepseek");

type BalanceInfo = {
  currency: string;
  total: number;
  granted: number;
  topped: number;
};

export type DeepseekOptions = Readonly<Record<string, never>>;

export const deepseekProviderDefinition = defineProvider<DeepseekOptions>({
  metadata: {
    id: "deepseek",
    displayName: "deepseek",
    catalogOrder: 30,
    officialApi: {
      baseUrls: ["https://api.deepseek.com"],
      documentationUrl: "https://api-docs.deepseek.com/api/get-user-balance",
      endpoints: [{ method: "GET", path: "/user/balance" }],
    },
  },
  credentialPolicy: {
    allowedSources: ["opencode", "env"],
    defaultCandidates: [
      { source: "opencode", variant: "deepseek", name: "deepseek" },
      { source: "env", variant: "deepseek", name: "DEEPSEEK_API_KEY" },
    ],
  },
  parseOptions: parseEmptyOptions,
  fetchUsage: fetchDeepseekUsage,
  present: deepseekProviderToView,
  resolveCacheScopeMetadata: () => null,
});

const deepseekLegacyBridge: LegacyProviderBridge = {
  configKey: "show_deepseek",
  isAvailable: () => true,
  resolve: resolveLegacyDeepseekContext,
};

export const deepseekUsageAdapter = new LegacyAdapterFacade(
  deepseekProviderDefinition.registration,
  deepseekLegacyBridge,
);

async function fetchDeepseekUsage(context: ProviderFetchContext<DeepseekOptions>): Promise<StandardUsageProvider> {
  if (context.signal.aborted) return statusProvider("error", "cancelled");
  if (context.credential.variant !== "deepseek") {
    return statusProvider("error", "invalid credential variant");
  }
  const controller = createTimeoutController(context.timeoutMs, context.signal);
  try {
    const response = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${context.credential.secret}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
    if (!response.ok) return statusProvider("error", `api ${response.status}`);
    return normalizeDeepseekBalance(await response.json());
  } catch (error: unknown) {
    const message = context.signal.aborted
      ? "cancelled"
      : controller.signal.aborted
        ? "timeout"
        : sanitizeCredentialError(error, context.credential.secret);
    return statusProvider("error", message);
  } finally {
    controller.dispose();
  }
}

function resolveLegacyDeepseekContext(context: ProviderContext, signal: AbortSignal) {
  const credential = resolveLegacyDeepseekCredential(context);
  if (!credential.ok) return { ok: false as const, status: "missing-auth" as const, message: credential.message };
  return {
    ok: true as const,
    options: {},
    fetchContext: {
      credential: {
        secret: credential.secret,
        source: credential.source,
        variant: "deepseek",
        epoch: 0,
      },
      signal,
      timeoutMs: context.timeoutMs,
    },
  };
}

type LegacyDeepseekCredential =
  | Readonly<{ ok: true; secret: string; source: "opencode" | "env" }>
  | Readonly<{ ok: false; message: string }>;

function resolveLegacyDeepseekCredential(context: ProviderContext): LegacyDeepseekCredential {
  const authCredential = discoverDeepseekCredential(context.auth, {});
  if ("token" in authCredential) {
    return { ok: true, secret: authCredential.token, source: "opencode" };
  }
  const envCredential = discoverDeepseekCredential({}, context.env);
  if ("token" in envCredential) {
    return { ok: true, secret: envCredential.token, source: "env" };
  }
  return { ok: false, message: envCredential.message };
}

function parseEmptyOptions(input: unknown): ValidationResult<DeepseekOptions> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return invalidOptions("options", "options must be an object");
  }
  const unknownKey = Object.keys(input)[0];
  return unknownKey ? invalidOptions(unknownKey, "unknown option") : { ok: true, value: Object.freeze({}) };
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
  const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
  return { ok: false, issues };
}

export function normalizeDeepseekBalance(raw: unknown, nowMs: number = Date.now()): StandardUsageProvider {
  const root = asRecord(raw) ?? {};
  const infos = parseBalanceInfos(root.balance_infos);
  const available = root.is_available === true;
  if (infos.length === 0) {
    return {
      id: "deepseek",
      displayName: "deepseek",
      status: "partial",
      statusText: "no balance",
      windows: [],
      fetchedAt: nowMs,
    };
  }
  const cny = infos.find((info) => info.currency === "CNY") ?? infos[0];
  const window = balanceWindow(cny, nowMs);
  return {
    id: "deepseek",
    displayName: "deepseek",
    status: available ? "ready" : "partial",
    ...(available ? {} : { statusText: "API access unavailable" }),
    windows: [window],
    additionalProperties: sanitizeAdditionalProperties({
      deepseekCurrency: cny.currency,
      deepseekGrantedAmount: cny.granted,
      deepseekToppedAmount: cny.topped,
    }),
    fetchedAt: nowMs,
  };
}

function balanceWindow(info: BalanceInfo, nowMs: number): StandardUsageWindow {
  const standard = {
    id: `deepseek-${slug(info.currency)}`,
    label: "balance",
    kind: "credits" as const,
    currentValue: info.total,
    unitLabel: info.currency,
    additionalProperties: sanitizeAdditionalProperties({ nowMs }),
  } satisfies StandardUsageWindow;
  return { ...standard, severity: getWindowSeverity(standard) };
}

function parseBalanceInfos(raw: unknown): BalanceInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): BalanceInfo[] => {
    const data = asRecord(entry);
    if (!data) return [];
    const currency = readString(data.currency);
    const total = parseAmount(data.total_balance);
    const granted = parseAmount(data.granted_balance);
    const topped = parseAmount(data.topped_up_balance);
    if (!currency || total === undefined) return [];
    return [{ currency, total, granted: granted ?? 0, topped: topped ?? 0 }];
  });
}

function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
