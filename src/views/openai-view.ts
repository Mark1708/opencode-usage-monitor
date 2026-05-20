import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";
import { metricSummary, statusView, stringMetric, toViewStatus, windowMetric } from "./common.js";

const DEBUG_KEYS = [
  "creditsApproxLocalMessages",
  "creditsApprox_local_messages",
  "spendControlIndividualLimit",
  "spendControlIndividual_limit",
  "rateLimitResetCreditsHas",
  "rateLimitResetCreditsHas_credits",
];

export function openAIProviderToView(provider: StandardUsageProvider): ProviderUsageView {
  const status = statusView(provider);
  if (status) return status;

  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true, detailOnly: true }),
    stringMetric("credits", "credits", provider.additionalProperties?.creditsBalance, 90, { compact: true, detailOnly: true }),
    stringMetric("credits-normalized", "credits", provider.additionalProperties?.creditsHas ?? provider.additionalProperties?.creditsHas_credits, 10, { detailOnly: true }),
    ...provider.windows.map((window, index) => windowMetric(window, 80 - index)),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  const details = DEBUG_KEYS.map((key, index) => stringMetric(`debug-${key}`, debugLabel(key), provider.additionalProperties?.[key], 20 - index, { detailOnly: true, tone: "muted" }))
    .filter((metric): metric is UsageMetric => metric !== undefined);

  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    ...(details.length > 0 ? { details } : {}),
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...(provider.staleAt !== undefined ? { stale: true } : {}),
  };
}

function debugLabel(key: string): string {
  return key
    .replace(/^credits/, "")
    .replace(/^spendControl/, "spend")
    .replace(/^rateLimitResetCredits/, "reset")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase() || key;
}
