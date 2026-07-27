import type { ProviderContext, StandardUsageProvider, StandardUsageWindow, UsageProviderAdapter } from "./types.js";
import { discoverDeepseekCredential } from "../auth.js";
import { sanitizeAdditionalProperties, sanitizeError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { asRecord, createStatusProvider, createTimeoutController, readString, slug } from "./shared.js";

const BALANCE_URL = "https://api.deepseek.com/user/balance";
const statusProvider = createStatusProvider("deepseek", "deepseek");

type BalanceInfo = {
  currency: string;
  total: number;
  granted: number;
  topped: number;
};

export const deepseekUsageAdapter: UsageProviderAdapter = {
  id: "deepseek",
  displayName: "deepseek",
  configKey: "show_deepseek",
  isAvailable: () => true,
  fetchUsage: fetchDeepseekUsage,
};

async function fetchDeepseekUsage(ctx: ProviderContext, signal: AbortSignal): Promise<StandardUsageProvider> {
  const credential = discoverDeepseekCredential(ctx.auth, ctx.env);
  if (!("token" in credential)) return statusProvider("missing-auth", credential.message);

  const controller = createTimeoutController(ctx.timeoutMs, signal);
  try {
    const response = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${credential.token}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
    if (!response.ok) return statusProvider("error", `api ${response.status}`);
    return normalizeDeepseekBalance(await response.json());
  } catch (error: unknown) {
    return statusProvider("error", controller.signal.aborted ? "timeout" : sanitizeError(error));
  } finally {
    controller.dispose();
  }
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
