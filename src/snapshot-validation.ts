import type {
  ProviderDetail,
  StandardModelBreakdown,
  StandardUsageAlert,
  StandardUsageProvider,
  StandardUsageWindow,
  UsageAmount,
  UsagePeriod,
} from "./providers/types.js";
import { hasSecretPattern, looksSecretKey } from "./sanitize.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_VALUE_DEPTH = 10;
const MAX_VALUE_NODES = 5_000;
const SUCCESS_STATUSES = new Set<StandardUsageProvider["status"]>(["ready", "partial"]);
const WINDOW_KINDS = new Set<StandardUsageWindow["kind"]>([
  "rolling", "daily", "weekly", "monthly", "billing", "tokens",
  "requests", "credits", "cost", "unknown",
]);
const SEVERITIES = new Set(["normal", "warning", "critical", "muted"]);
const DETAIL_VISIBILITIES = new Set(["summary", "detail", "debug"]);
const DETAIL_TONES = new Set(["normal", "muted", "good", "warn", "bad"]);

type DetachedJson = null | boolean | number | string | DetachedJsonArray | DetachedJsonObject;
interface DetachedJsonArray extends ReadonlyArray<DetachedJson> {}
interface DetachedJsonObject extends Readonly<Record<string, DetachedJson>> {}
type DetachResult = Readonly<{
  value: DetachedJson | undefined;
  nodes: number;
  bytes: number;
  valid: boolean;
  credential: boolean;
}>;

export type UsageSnapshotValidation =
  | Readonly<{ ok: true; snapshot: StandardUsageProvider }>
  | Readonly<{ ok: false; reason: "credential" | "invalid" }>;

export type UsageSnapshotValidationOptions = Readonly<{
  credential?: string;
  fetchedAt?: number;
}>;

export function validateAndCloneUsageSnapshot(
  snapshot: unknown,
  providerId: string,
  options: UsageSnapshotValidationOptions = {},
): UsageSnapshotValidation {
  try {
    const detached = detachJsonValue(snapshot, 0, 0, options.credential ?? "");
    if (detached.credential) return { ok: false, reason: "credential" };
    if (!detached.valid || !isPlainRecord(detached.value)) return { ok: false, reason: "invalid" };
    const candidate = options.fetchedAt === undefined
      ? detached.value
      : Object.freeze({ ...detached.value, fetchedAt: options.fetchedAt });
    if (!isFinalSnapshotSizeValid(candidate)) return { ok: false, reason: "invalid" };
    if (!isSuccessfulSnapshot(candidate, providerId)) return { ok: false, reason: "invalid" };
    return { ok: true, snapshot: deepFreeze(candidate) };
  } catch (_error: unknown) {
    return { ok: false, reason: "invalid" };
  }
}

export function isSecretBearingKey(key: string): boolean {
  if (key === "key") return false;
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return looksSecretKey(key)
    || [
      "token", "secret", "credential", "password", "session", "cookie",
      "authorization", "privatekey", "clientsecret",
    ].some((fragment) => normalized.includes(fragment));
}

function detachJsonValue(value: unknown, depth: number, nodes: number, credential: string): DetachResult {
  if (depth > MAX_VALUE_DEPTH || nodes >= MAX_VALUE_NODES) return invalidDetach(nodes, MAX_SNAPSHOT_BYTES + 1);
  if (value === null || typeof value === "boolean") return primitiveDetach(value, nodes, credential);
  if (typeof value === "number") {
    return Number.isFinite(value) ? primitiveDetach(value, nodes, credential) : invalidDetach(nodes + 1, 0);
  }
  if (typeof value === "string") return stringDetach(value, nodes, credential);
  if (Array.isArray(value)) return detachArray(value, depth, nodes + 1, credential);
  if (typeof value === "object" && value !== null) return detachRecord(value, depth, nodes + 1, credential);
  return invalidDetach(nodes + 1, 0);
}

function primitiveDetach(value: null | boolean | number, nodes: number, credential: string): DetachResult {
  const text = String(value);
  return boundedDetach(value, nodes + 1, Buffer.byteLength(text), true, credential.length > 0 && text.includes(credential));
}

function stringDetach(value: string, nodes: number, credential: string): DetachResult {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  const foundCredential = credential.length > 0 && value.includes(credential);
  return boundedDetach(value, nodes + 1, bytes, !hasSecretPattern(value), foundCredential);
}

function detachArray(value: readonly unknown[], depth: number, nodes: number, credential: string): DetachResult {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return invalidDetach(nodes, 0);
  const length = readArrayLength(value);
  if (length === null || length > MAX_VALUE_NODES - nodes) return invalidDetach(nodes, 0);
  if (keys.length !== length + 1) return invalidDetach(nodes, 0);
  if (keys.some((key) => typeof key !== "string" || (key !== "length" && !isArrayIndex(key, length)))) {
    return invalidDetach(nodes, 0);
  }
  let result: DetachResult = boundedDetach(Object.freeze([]), nodes, 2, true, false);
  let items: readonly DetachedJson[] = Object.freeze([]);
  for (let index = 0; index < length; index += 1) {
    const descriptor = readDataDescriptor(value, String(index));
    if (!descriptor) return invalidDetach(result.nodes, result.bytes);
    const child = detachJsonValue(descriptor.value, depth + 1, result.nodes, credential);
    items = child.value === undefined ? items : Object.freeze([...items, child.value]);
    result = combineDetach(result, child, index > 0 ? 1 : 0, items);
    if (result.bytes > MAX_SNAPSHOT_BYTES || result.nodes > MAX_VALUE_NODES) return result;
  }
  return result;
}

function detachRecord(value: object, depth: number, nodes: number, credential: string): DetachResult {
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return invalidDetach(nodes, 0);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) return invalidDetach(nodes, 0);
  if (keys.length > MAX_VALUE_NODES - nodes) return invalidDetach(nodes, 0);
  let result: DetachResult = boundedDetach(Object.freeze({}), nodes, 2, true, false);
  let output: Readonly<Record<string, DetachedJson>> = Object.freeze({});
  for (const key of keys) {
    if (typeof key !== "string") return invalidDetach(result.nodes, result.bytes);
    const descriptor = readDataDescriptor(value, key);
    if (!descriptor) return invalidDetach(result.nodes, result.bytes);
    const child = detachJsonValue(descriptor.value, depth + 1, result.nodes, credential);
    if (child.value !== undefined) output = Object.freeze({ ...output, [key]: child.value });
    const keyBytes = Buffer.byteLength(JSON.stringify(key)) + 1 + (Object.keys(output).length > 1 ? 1 : 0);
    const keyContainsCredential = credential.length > 0 && key.includes(credential);
    const safeChild = isSecretBearingKey(key)
      ? Object.freeze({ ...child, valid: false, credential: child.credential || keyContainsCredential })
      : Object.freeze({ ...child, credential: child.credential || keyContainsCredential });
    result = combineDetach(result, safeChild, keyBytes, output);
    if (result.bytes > MAX_SNAPSHOT_BYTES || result.nodes > MAX_VALUE_NODES) return result;
  }
  return result;
}

function combineDetach(parent: DetachResult, child: DetachResult, overhead: number, value: DetachedJson): DetachResult {
  return boundedDetach(
    value,
    child.nodes,
    parent.bytes + child.bytes + overhead,
    parent.valid && child.valid,
    parent.credential || child.credential,
  );
}

function boundedDetach(
  value: DetachedJson,
  nodes: number,
  bytes: number,
  valid: boolean,
  credential: boolean,
): DetachResult {
  const withinBudget = nodes <= MAX_VALUE_NODES && bytes <= MAX_SNAPSHOT_BYTES;
  return Object.freeze({ value: withinBudget ? value : undefined, nodes, bytes, valid: valid && withinBudget, credential });
}

function invalidDetach(nodes: number, bytes: number): DetachResult {
  return Object.freeze({ value: undefined, nodes, bytes, valid: false, credential: false });
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function readArrayLength(value: readonly unknown[]): number | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "number") return null;
  return Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 ? descriptor.value : null;
}

function readDataDescriptor(value: object, key: string): PropertyDescriptor | null {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor?.enumerable && "value" in descriptor ? descriptor : null;
}

function isFinalSnapshotSizeValid(value: DetachedJsonObject): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_SNAPSHOT_BYTES;
}

function isSuccessfulSnapshot(value: unknown, providerId: string): value is StandardUsageProvider {
  if (!isPlainRecord(value) || value.id !== providerId || !isSuccessStatus(value.status)) return false;
  if (!isBoundedString(value.displayName, 128) || !Array.isArray(value.windows)) return false;
  if (!value.windows.every(isUsageWindow) || !isPositiveFiniteNumber(value.fetchedAt)) return false;
  if (value.errorMessage !== undefined) return false;
  if (!isOptionalBoundedString(value.statusText, 1_024) || !isOptionalBoundedString(value.plan, 256)) return false;
  if (!isOptionalFiniteNumber(value.staleAt) || !isOptionalFiniteNumber(value.lastGoodAt)) return false;
  if (value.additionalProperties !== undefined) return false;
  if (value.details !== undefined && (!Array.isArray(value.details) || !value.details.every(isProviderDetail))) return false;
  if (value.alerts !== undefined && (!Array.isArray(value.alerts) || !value.alerts.every(isUsageAlert))) return false;
  if (value.modelBreakdown !== undefined && (!Array.isArray(value.modelBreakdown) || !value.modelBreakdown.every(isModelBreakdown))) return false;
  return providerKeysAreKnown(value);
}

function isUsageWindow(value: unknown): value is StandardUsageWindow {
  if (!isPlainRecord(value)) return false;
  if (!isBoundedString(value.id, 256) || !isBoundedString(value.label, 256)) return false;
  return isCanonicalUsageWindow(value);
}

function isCanonicalUsageWindow(value: Readonly<Record<string, unknown>>): boolean {
  if (!isUsagePeriod(value.period) || !isUsageAmount(value.usage)) return false;
  if (value.kind !== undefined && (typeof value.kind !== "string" || !WINDOW_KINDS.has(value.kind as StandardUsageWindow["kind"]))) return false;
  if (!optionalNumbersAreFinite(value, ["percentage", "used", "limit", "remaining", "currentValue", "resetAt"])) return false;
  if (!isOptionalBoundedString(value.unitLabel, 128)) return false;
  if (!isOptionalBoundedString(value.resetLabel, 512) || !isOptionalBoundedString(value.budgetLabel, 512)) return false;
  if (!isOptionalPositiveFiniteNumber(value.resetAt)) return false;
  if (value.limitReached !== undefined && typeof value.limitReached !== "boolean") return false;
  if (value.severity !== undefined && !isSeverity(value.severity)) return false;
  if (!windowKeysAreKnown(value)) return false;
  return value.summaryDetails === undefined || isBoundedStringArray(value.summaryDetails, 512);
}

function isUsagePeriod(value: unknown): value is UsagePeriod {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "unknown") return keysAreAllowed(value, ["kind"]);
  if (value.kind === "rolling") {
    return isPositiveFiniteNumber(value.durationMs) && keysAreAllowed(value, ["kind", "durationMs"]);
  }
  if (value.kind === "calendar") {
    return ["day", "week", "month", "billing"].includes(String(value.unit)) && keysAreAllowed(value, ["kind", "unit"]);
  }
  return false;
}

function isUsageAmount(value: unknown): value is UsageAmount {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "percent") {
    return isNonNegativeFiniteNumber(value.usedPercent) && keysAreAllowed(value, ["kind", "usedPercent"]);
  }
  if (value.kind === "quota") {
    return isNonNegativeFiniteNumber(value.used)
      && isPositiveFiniteNumber(value.limit)
      && isBoundedString(value.unit, 64)
      && keysAreAllowed(value, ["kind", "used", "limit", "unit"]);
  }
  return false;
}

function isProviderDetail(value: unknown): value is ProviderDetail {
  return isPlainRecord(value)
    && isBoundedString(value.key, 256)
    && !isSecretBearingKey(value.key)
    && isBoundedString(value.label, 256)
    && !isSecretBearingKey(value.label)
    && isDetailValue(value.value)
    && typeof value.visibility === "string"
    && DETAIL_VISIBILITIES.has(value.visibility)
    && isOptionalFiniteNumber(value.priority)
    && (value.tone === undefined || (typeof value.tone === "string" && DETAIL_TONES.has(value.tone)))
    && keysAreAllowed(value, ["key", "label", "value", "visibility", "priority", "tone"]);
}

function isDetailValue(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "text") return isBoundedString(value.value, 2_048) && keysAreAllowed(value, ["kind", "value"]);
  if (value.kind === "flag") return typeof value.value === "boolean" && keysAreAllowed(value, ["kind", "value"]);
  if (value.kind === "number") {
    return isOptionalBoundedString(value.unit, 64)
      && isOptionalFiniteNumber(value.value)
      && value.value !== undefined
      && keysAreAllowed(value, ["kind", "value", "unit"]);
  }
  if (value.kind === "currency") {
    return isOptionalFiniteNumber(value.value)
      && value.value !== undefined
      && isBoundedString(value.currency, 16)
      && keysAreAllowed(value, ["kind", "value", "currency"]);
  }
  return false;
}

function isUsageAlert(value: unknown): value is StandardUsageAlert {
  return isPlainRecord(value)
    && isBoundedString(value.id, 256)
    && isBoundedString(value.label, 512)
    && isSeverity(value.severity)
    && value.additionalProperties === undefined
    && keysAreAllowed(value, ["id", "label", "severity"]);
}

function isModelBreakdown(value: unknown): value is StandardModelBreakdown {
  return isPlainRecord(value)
    && isBoundedString(value.id, 256)
    && isBoundedString(value.label, 512)
    && optionalNumbersAreFinite(value, ["percentage", "used", "costUsd", "requests"])
    && isOptionalBoundedString(value.unitLabel, 128)
    && (value.severity === undefined || isSeverity(value.severity))
    && keysAreAllowed(value, [
      "id", "label", "percentage", "used", "unitLabel", "costUsd", "requests",
      "severity",
    ]);
}

function optionalNumbersAreFinite(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => isOptionalFiniteNumber(value[key]));
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOptionalPositiveFiniteNumber(value: unknown): boolean {
  return value === undefined || isPositiveFiniteNumber(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isSuccessStatus(value: unknown): value is "ready" | "partial" {
  return typeof value === "string" && SUCCESS_STATUSES.has(value as StandardUsageProvider["status"]);
}

function isSeverity(value: unknown): boolean {
  return typeof value === "string" && SEVERITIES.has(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function isBoundedStringArray(value: unknown, maxLength: number): boolean {
  return Array.isArray(value) && value.every((entry) => isBoundedString(entry, maxLength));
}

function windowKeysAreKnown(value: Readonly<Record<string, unknown>>): boolean {
  return keysAreAllowed(value, [
    "id", "label", "kind", "percentage", "used", "limit", "remaining",
    "currentValue", "unitLabel", "resetAt", "resetLabel", "budgetLabel",
    "limitReached", "severity", "summaryDetails", "period", "usage",
  ]);
}

function providerKeysAreKnown(value: Readonly<Record<string, unknown>>): boolean {
  return keysAreAllowed(value, [
    "id", "displayName", "status", "statusText", "plan", "windows", "alerts",
    "modelBreakdown", "details", "fetchedAt", "staleAt", "lastGoodAt",
  ]);
}

function keysAreAllowed(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
