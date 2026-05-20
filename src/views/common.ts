import type { StandardUsageProvider, StandardUsageWindow } from "../providers/types.js";
import { formatPercent, formatReset, formatTokens } from "../layout.js";
import { getWindowSeverity } from "../severity.js";
import type { ProviderUsageView, UsageMetric, UsageTone } from "./types.js";

type ViewStatus = ProviderUsageView["status"];

export function statusView(provider: StandardUsageProvider, missingAuthSummary = "needs auth"): ProviderUsageView | undefined {
  if (provider.status === "ready" || provider.status === "partial") return undefined;

  const summary = provider.status === "missing-auth"
    ? missingAuthSummary
    : provider.errorMessage ?? provider.statusText ?? provider.status;

  return {
    id: provider.id,
    title: provider.displayName,
    status: toViewStatus(provider.status),
    summary,
    metrics: [{ key: "status", label: "status", value: summary, tone: "muted", priority: 100, compact: true }],
    fetchedAt: provider.lastGoodAt ?? provider.fetchedAt,
  };
}

export function toViewStatus(status: StandardUsageProvider["status"]): ViewStatus {
  if (status === "loading") return "partial";
  return status;
}

export function windowMetric(window: StandardUsageWindow, priority: number): UsageMetric {
  return {
    key: `window-${window.id}`,
    label: window.label,
    value: windowValue(window),
    tone: severityTone(window.severity ?? getWindowSeverity(window)),
    priority,
    compact: true,
  };
}

export function windowValue(window: StandardUsageWindow): string {
  const main = formatPercent(window.percentage) || formatUsedLimit(window) || window.budgetLabel || "n/a";
  const suffix = [window.resetLabel ?? formatReset(window.resetAt)]
    .filter((part): part is string => part !== undefined && part.length > 0);
  return [main, ...suffix].join(" · ");
}

export function splitMetricValue(fullValue: string): { main: string; suffix?: string } {
  const dotIndex = fullValue.indexOf(" · ");
  if (dotIndex === -1) return { main: fullValue };

  const potentialSuffix = fullValue.slice(dotIndex + 3);
  if (potentialSuffix.startsWith("reset ")) {
    return { main: fullValue.slice(0, dotIndex), suffix: potentialSuffix };
  }

  return { main: fullValue };
}

export function metricSummary(metrics: UsageMetric[], maxCount = 2): string | undefined {
  const parts = [...metrics]
    .filter((metric) => metric.compact === true && metric.detailOnly !== true)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, maxCount)
    .map((metric) => (metric.key === "plan" ? metric.value : `${metric.label} ${metric.value.split(" · ")[0] ?? metric.value}`));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function stringMetric(key: string, label: string, value: unknown, priority: number, options: { compact?: boolean; tone?: UsageTone; detailOnly?: boolean } = {}): UsageMetric | undefined {
  const formatted = formatUnknown(value);
  if (formatted === undefined || formatted.length === 0) return undefined;
  return { key, label, value: formatted, priority, ...options };
}

export function formatUnknown(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return formatTokens(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return `items[${value.length}]`;
  if (value && typeof value === "object") return `props[${Object.keys(value).length}]`;
  return undefined;
}

function severityTone(severity: "normal" | "warning" | "critical" | "muted"): UsageTone {
  if (severity === "critical") return "bad";
  if (severity === "warning") return "warn";
  if (severity === "muted") return "muted";
  return "good";
}

function formatUsedLimit(window: StandardUsageWindow): string | undefined {
  if (window.used !== undefined && window.limit !== undefined) {
    return `${formatTokens(window.used)}/${formatTokens(window.limit)}${window.unitLabel ? ` ${window.unitLabel}` : ""}`;
  }
  if (window.remaining !== undefined) return `${formatTokens(window.remaining)} left`;
  if (window.currentValue !== undefined) return `${formatTokens(window.currentValue)} current`;
  return undefined;
}

function formatRemaining(window: StandardUsageWindow): string | undefined {
  if (window.remaining === undefined) return undefined;
  return `${formatTokens(window.remaining)} left`;
}
