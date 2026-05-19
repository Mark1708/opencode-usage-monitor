import type { OpenAIUsageData, ZaiLimitEntry, ZaiUsageData } from "./types.js";

// --- Line safety helpers (from agents-sidebar pattern) ---

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

export function padRight(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  const truncated = truncateTo(value, normalizedWidth);
  return truncated.padEnd(normalizedWidth, " ");
}

export function padLeft(value: string, width: number): string {
  const normalizedWidth = Math.max(0, width);
  const truncated = truncateTo(value, normalizedWidth);
  return truncated.padStart(normalizedWidth, " ");
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

// --- Usage-specific formatters ---

export function formatAge(timestampMs: number, nowMs: number = Date.now()): string {
  const diffMs = nowMs - timestampMs;
  if (diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) {
    const val = count / 1000;
    return val === Math.floor(val) ? `${val}K` : `${val.toFixed(1)}K`;
  }
  if (count < 1_000_000_000) {
    const val = count / 1_000_000;
    return val === Math.floor(val) ? `${val}M` : `${val.toFixed(1)}M`;
  }
  const val = count / 1_000_000_000;
  return val === Math.floor(val) ? `${val}B` : `${val.toFixed(1)}B`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || value === null) return "";
  return `${Math.round(value)}%`;
}

export function formatReset(resetAtMs: number | undefined, nowMs: number = Date.now()): string {
  if (resetAtMs === undefined || resetAtMs === null) return "";
  const diffMs = resetAtMs - nowMs;
  if (diffMs <= 0) return "reset now";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `reset ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `reset ${hours}h`;
  const days = Math.floor(hours / 24);
  return `reset ${days}d`;
}

const PROVIDER_NAME_WIDTH = 14;

export function formatProviderStatusLine(provider: string, status: string, width: number): string {
  const name = padRight(`  ${provider}`, PROVIDER_NAME_WIDTH);
  return truncateTo(`${name}${status}`, Math.max(0, width));
}

export function formatOpenAILine1(data: OpenAIUsageData | Partial<OpenAIUsageData>, width: number): string {
  const name = padRight("  openai", PROVIDER_NAME_WIDTH);
  const parts: string[] = [];

  if (data.planType) {
    parts.push(data.planType);
  }

  const primary = data.rateLimit?.primaryWindow;
  if (primary && primary.usedPercent !== undefined) {
    parts.push(`${formatPercent(primary.usedPercent)}`);
  }

  if (data.rateLimit?.limitReached) {
    parts.push("LIMIT");
  }

  if (parts.length > 0) {
    return truncateTo(`${name}${parts.join(" ")}`, Math.max(0, width));
  }

  return truncateTo(`${name}loading`, Math.max(0, width));
}

export function formatOpenAILine2(data: OpenAIUsageData | Partial<OpenAIUsageData>, width: number): string {
  const indent = " ".repeat(PROVIDER_NAME_WIDTH);
  const parts: string[] = [];

  const secondary = data.rateLimit?.secondaryWindow;
  if (secondary && secondary.usedPercent !== undefined && secondary.usedPercent > 0) {
    parts.push(`weekly ${formatPercent(secondary.usedPercent)}`);
  }

  const primary = data.rateLimit?.primaryWindow;
  const resetStr = primary?.resetAt ? formatReset(primary.resetAt * 1000) : "";
  if (resetStr) parts.push(resetStr);

  if (data.credits && !data.credits.unlimited && data.credits.balance !== "0") {
    parts.push(`bal ${data.credits.balance}`);
  }

  if (parts.length > 0) {
    return truncateTo(`${indent}${parts.join(" \u00b7 ")}`, Math.max(0, width));
  }

  return truncateTo(indent, Math.max(0, width));
}

function findLimitEntry(
  limits: ZaiLimitEntry[] | undefined,
  limitType: string,
): ZaiLimitEntry | undefined {
  return limits?.find((entry) => entry.type === limitType);
}

export function formatZaiLine1(data: ZaiUsageData | Partial<ZaiUsageData>, width: number): string {
  const name = padRight("  z.ai", PROVIDER_NAME_WIDTH);
  const parts: string[] = [];

  const timeLimit = findLimitEntry(data.limits, "TIME_LIMIT");

  if (timeLimit?.percentage !== undefined) {
    parts.push(`5h ${formatPercent(timeLimit.percentage)}`);
  }

  const resetStr = formatReset(timeLimit?.nextResetTime);
  if (resetStr) parts.push(resetStr);

  if (parts.length > 0) {
    return truncateTo(`${name}${parts.join(" ")}`, Math.max(0, width));
  }

  if (data.planName) {
    return truncateTo(`${name}${data.planName}`, Math.max(0, width));
  }

  return truncateTo(`${name}loading`, Math.max(0, width));
}

export function formatZaiLine2(data: ZaiUsageData | Partial<ZaiUsageData>, width: number): string {
  const indent = " ".repeat(PROVIDER_NAME_WIDTH);
  const parts: string[] = [];

  const tokensLimit = findLimitEntry(data.limits, "TOKENS_LIMIT");

  if (tokensLimit?.percentage !== undefined) {
    parts.push(`tokens ${formatPercent(tokensLimit.percentage)}`);
  } else if (tokensLimit?.remaining !== undefined) {
    parts.push(`${tokensLimit.remaining} left`);
  }

  const rateLimit = findLimitEntry(data.limits, "RATE_LIMIT");
  if (rateLimit?.percentage !== undefined) {
    parts.push(`rate ${formatPercent(rateLimit.percentage)}`);
  }

  if (parts.length > 0) {
    return truncateTo(`${indent}${parts.join(" \u00b7 ")}`, Math.max(0, width));
  }

  return truncateTo(indent, Math.max(0, width));
}

export function formatStaleSuffix(fetchedAtMs: number, nowMs: number = Date.now()): string {
  if (fetchedAtMs <= 0) return "";
  const diffMs = nowMs - fetchedAtMs;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 2) return "";
  if (minutes < 60) return `stale ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `stale ${hours}h`;
}

// --- Error sanitization ---

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{10,}/g,
  /key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /token[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /api[_-]?key[=:]\s*[a-zA-Z0-9._-]{10,}/gi,
  /Authorization:\s*\S+/gi,
];

export function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted]");
  }
  return sanitized.split("\n")[0] ?? "error";
}
