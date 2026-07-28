import type { StandardUsageProvider } from "./providers/types.js";
import { sanitizeCredentialError } from "./sanitize.js";
import { validateAndCloneUsageSnapshot } from "./snapshot-validation.js";

export const CREDENTIAL_DATA_MESSAGE = "Provider response contained credential data";
export const INVALID_PROVIDER_DATA_MESSAGE = "Provider returned invalid data";
const PROVIDER_FAILURE_FALLBACK = "Provider refresh failed";
const MAX_PROVIDER_FAILURE_LENGTH = 1_024;

export type PreparedProviderSnapshot =
  | Readonly<{ ok: true; snapshot: StandardUsageProvider }>
  | Readonly<{ ok: false; reason: "credential" | "invalid" }>;

export function prepareProviderSnapshot(
  snapshot: StandardUsageProvider,
  credential: string,
  expectedProviderId: string,
  fetchedAt?: number,
): PreparedProviderSnapshot {
  return validateAndCloneUsageSnapshot(snapshot, expectedProviderId, { credential, fetchedAt });
}

export function sanitizeProviderFailure(error: unknown, credential: string): string {
  try {
    const redacted = sanitizeCredentialError(error, credential);
    const oneLine = redacted.replace(/[\r\n]+/g, " ").trim();
    return (oneLine || PROVIDER_FAILURE_FALLBACK).slice(0, MAX_PROVIDER_FAILURE_LENGTH);
  } catch (_error: unknown) {
    return PROVIDER_FAILURE_FALLBACK;
  }
}

export function successfulRuntimeStatus(snapshot: StandardUsageProvider): "ready" | "partial" {
  return snapshot.status === "partial" ? "partial" : "ready";
}
