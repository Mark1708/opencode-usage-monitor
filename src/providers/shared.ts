import { sanitizeError } from "../sanitize.js";
import type { StandardUsageProvider } from "./types.js";

export type TimeoutController = AbortController & { clear: () => void; dispose: () => void };

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readNumber(value: unknown): number | undefined;
export function readNumber(value: unknown, fallback: number): number;
export function readNumber(value: unknown, fallback?: number): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

export function slug(name: string | undefined): string {
  return name?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "limit";
}

export function normalizeEpochMs(value: unknown): number | undefined {
  const epochMs = readNumber(value);
  if (epochMs === undefined || epochMs <= 0) return undefined;
  return epochMs < 10_000_000_000 ? epochMs * 1000 : epochMs;
}

export function createTimeoutController(timeoutMs: number, parent?: AbortSignal): TimeoutController {
  const controller = new AbortController() as TimeoutController;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const abort = (): void => controller.abort();
  parent?.addEventListener("abort", abort, { once: true });
  const clear = (): void => {
    clearTimeout(timeoutId);
    parent?.removeEventListener("abort", abort);
  };
  controller.clear = clear;
  controller.dispose = clear;
  return controller;
}

export function createStatusProvider(
  id: string,
  displayName: string,
): (status: StandardUsageProvider["status"], message: string) => StandardUsageProvider {
  return (status, message) => ({
    id,
    displayName,
    status,
    statusText: sanitizeError(message),
    errorMessage: status === "error" ? sanitizeError(message) : undefined,
    windows: [],
  });
}
