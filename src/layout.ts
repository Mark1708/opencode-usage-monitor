import type { StandardUsageProvider, UsageSeverity } from "./providers/types.js";
import type { UsageMetric, UsageTone } from "./views/types.js";

export const PROVIDER_NAME_WIDTH = 14;

export function sanitizeLine(value: string): string {
  return value.replace(/[\r\n]/g, " ");
}

export function truncateTo(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  const line = sanitizeLine(value);
  if (normalizedWidth <= 0) return "";
  if (line.length <= normalizedWidth) return line;
  if (normalizedWidth === 1) return "\u2026";
  return `${line.slice(0, normalizedWidth - 1)}\u2026`;
}

export function truncateSmart(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  let line = sanitizeLine(value);
  if (line.length <= normalizedWidth) return line;

  while (line.includes(" · ")) {
    const lastSeparator = line.lastIndexOf(" · ");
    if (lastSeparator <= 0) break;
    line = line.slice(0, lastSeparator);
    if (line.length <= normalizedWidth) return line;
  }

  return truncateTo(line, normalizedWidth);
}

export function padRight(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  return truncateTo(value, normalizedWidth).padEnd(normalizedWidth, " ");
}

export function padLeft(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  return truncateTo(value, normalizedWidth).padStart(normalizedWidth, " ");
}

export function formatHeaderLine(left: string, right: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  const leftLine = sanitizeLine(left);
  const rightLine = sanitizeLine(right);
  if (normalizedWidth <= 0) return "";
  if (rightLine.length >= normalizedWidth) return truncateTo(rightLine, normalizedWidth);
  const leftBudget = Math.max(0, normalizedWidth - rightLine.length);
  const safeLeft = leftLine.length > leftBudget ? truncateTo(leftLine, leftBudget) : leftLine;
  const padding = " ".repeat(Math.max(0, normalizedWidth - safeLeft.length - rightLine.length));
  return `${safeLeft}${padding}${rightLine}`;
}

export function formatAge(timestampMs: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - timestampMs;
  if (diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatReset(resetAtMs: number | undefined, nowMs: number = Date.now()): string {
  if (resetAtMs === undefined) return "";
  const diffMs = resetAtMs - nowMs;
  if (diffMs <= 0) return "reset now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `reset ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `reset ${hours}h`;
  return `reset ${Math.floor(hours / 24)}d`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined) return "";
  return `${Math.round(value)}%`;
}

export function formatTokens(count: number): string {
  const abs = Math.abs(count);
  if (abs < 1000) return String(count);
  if (abs < 1_000_000) return formatCompact(count, 1000, "K");
  if (abs < 1_000_000_000) return formatCompact(count, 1_000_000, "M");
  return formatCompact(count, 1_000_000_000, "B");
}

export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}

export function formatProviderStatusLine(provider: StandardUsageProvider | string, status: string, width: number): string {
  const displayName = typeof provider === "string" ? provider : provider.displayName;
  const name = padRight(`  ${displayName}`, PROVIDER_NAME_WIDTH);
  return truncateTo(`${name}${status}`, width);
}

export function formatStaleSuffix(fetchedAtMs: number | undefined, nowMs: number = Date.now()): string {
  if (fetchedAtMs === undefined || fetchedAtMs <= 0) return "";
  const minutes = Math.floor((nowMs - fetchedAtMs) / 60_000);
  if (minutes < 2) return "";
  if (minutes < 60) return `stale ${minutes}m`;
  return `stale ${Math.floor(minutes / 60)}h`;
}

/** Compute label column width from visible metrics. min 4, max 10 */
export function metricLabelWidth(metrics: Pick<UsageMetric, "label">[]): number {
  const maxLabel = metrics.reduce((max, metric) => Math.max(max, sanitizeLine(metric.label).length), 0);
  return Math.min(10, Math.max(4, maxLabel));
}

/** Format a metric line: "    label      value" */
export function formatMetricLine(label: string, value: string, labelWidth: number, totalWidth: number): string {
  const safeLabel = padRight(label, labelWidth);
  return truncateSmart(`    ${safeLabel}  ${sanitizeLine(value)}`, totalWidth);
}

/** Select top N metrics by priority for compact display */
export function selectCompactMetrics(metrics: UsageMetric[], maxCount: number): UsageMetric[] {
  return [...metrics]
    .filter((metric) => metric.compact === true && metric.detailOnly !== true)
    .sort((left, right) => right.priority - left.priority)
    .slice(0, Math.max(0, maxCount));
}

/** Format provider title line with collapse indicator and optional summary */
export function formatProviderTitleLine(title: string, collapsed: boolean, summary: string | undefined, width: number): string {
  const indicator = collapsed ? "▶" : "▼";
  const left = `${indicator} ${sanitizeLine(title)}`;
  if (summary === undefined || summary.length === 0) return truncateTo(left, width);
  return formatHeaderLine(left, summary, width);
}

/** Map UsageTone to UsageSeverity for TUI coloring */
export function toneToSeverity(tone: UsageTone | undefined): UsageSeverity {
  if (tone === "warn") return "warning";
  if (tone === "bad") return "critical";
  if (tone === "muted") return "muted";
  return "normal";
}

function formatCompact(value: number, divisor: number, suffix: string): string {
  const compact = value / divisor;
  return Number.isInteger(compact) ? `${compact}${suffix}` : `${compact.toFixed(1)}${suffix}`;
}
