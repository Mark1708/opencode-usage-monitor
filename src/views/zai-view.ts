import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";
import { metricSummary, statusView, stringMetric, toViewStatus, windowMetric } from "./common.js";

const DETAIL_LABELS = ["search", "tools", "mcp"];

export function zaiProviderToView(provider: StandardUsageProvider): ProviderUsageView {
  const status = statusView(provider);
  if (status) return status;

  const metrics = [
    stringMetric("plan", "plan", provider.plan, 100, { compact: true, detailOnly: true }),
    ...provider.windows.filter((window) => isKnownWindow(window.label)).map((window) => windowMetric(window, priorityForWindow(window.label))),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  const detailMetrics = [
    ...DETAIL_LABELS.map((label, index) => stringMetric(`detail-${label}`, label, provider.additionalProperties?.[label], 40 - index, { detailOnly: true })),
    stringMetric("debug-provider-base-url", "base url", provider.additionalProperties?.providerBaseUrl, 1, { detailOnly: true, tone: "muted" }),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    ...(detailMetrics.length > 0 ? { details: detailMetrics } : {}),
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...(provider.staleAt !== undefined ? { stale: true } : {}),
  };
}

function priorityForWindow(label: string): number {
  if (label === "day") return 90;
  if (label === "5h") return 80;
  if (label === "month") return 70;
  return 50;
}

function isKnownWindow(label: string): boolean {
  return label === "day" || label === "5h" || label === "month";
}
