import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView, UsageMetric } from "./types.js";
import { metricSummary, providerDetailsToMetrics, statusView, toViewStatus, windowMetric } from "./common.js";

export function zaiProviderToView(provider: StandardUsageProvider): ProviderUsageView {
  const status = statusView(provider);
  if (status) return status;

  const metrics = [
    ...provider.windows.filter((window) => isKnownWindow(window.label)).map((window) => windowMetric(window, priorityForWindow(window.label))),
    ...providerDetailsToMetrics(provider.details),
  ].filter((metric): metric is UsageMetric => metric !== undefined);

  return {
    id: provider.id,
    title: provider.displayName,
    status: provider.staleAt !== undefined ? "stale" : toViewStatus(provider.status),
    summary: metricSummary(metrics),
    metrics,
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
    ...(provider.staleAt !== undefined ? { stale: true } : {}),
  };
}

function priorityForWindow(label: string): number {
  if (label === "week") return 90;
  if (label === "5h") return 80;
  if (label === "month") return 70;
  return 50;
}

function isKnownWindow(label: string): boolean {
  return label === "week" || label === "5h" || label === "month";
}
