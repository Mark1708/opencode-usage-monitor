import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { CacheDataShape, CacheScopeMetadata } from "./providers/contracts.js";
import type {
  StandardModelBreakdown,
  StandardUsageAlert,
  StandardUsageProvider,
  StandardUsageWindow,
} from "./providers/types.js";
import { hasSecretPattern, looksSecretKey } from "./sanitize.js";

export const CACHE_V2_SCHEMA_VERSION = 2;

const DEFAULT_BASE_DIR = join(tmpdir(), "opencode-usage-monitor-v2");
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const MAX_TEMPORARY_FILE_AGE_MS = 5 * 60 * 1_000;
const MAX_VALUE_DEPTH = 10;
const MAX_VALUE_NODES = 5_000;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SHAPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TEMPORARY_FILE_PATTERN = /^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}\.json\.tmp-[A-Za-z0-9-]+$/;
const SUCCESS_STATUSES = new Set<StandardUsageProvider["status"]>(["ready", "partial"]);
const WINDOW_KINDS = new Set<StandardUsageWindow["kind"]>([
  "rolling", "daily", "weekly", "monthly", "billing", "tokens",
  "requests", "credits", "cost", "unknown",
]);
const SEVERITIES = new Set(["normal", "warning", "critical", "muted"]);

export type CacheV2Target = Readonly<{
  providerId: string;
  generation: number;
  credentialEpoch: number;
  scope: CacheScopeMetadata | null;
}>;

export type CacheV2ReadResult =
  | Readonly<{ status: "hit"; snapshot: StandardUsageProvider; storage: "memory" | "persistent" }>
  | Readonly<{ status: "miss"; diagnostic: "cache-miss" }>
  | Readonly<{ status: "invalid"; diagnostic: "cache-invalid" | "cache-invalid-input" }>;

export type CacheV2WriteResult =
  | Readonly<{ status: "written"; storage: "memory" | "persistent" }>
  | Readonly<{ status: "rejected"; diagnostic: "cache-invalid-input" | "snapshot-invalid" }>
  | Readonly<{ status: "error"; diagnostic: "cache-write-failed" }>;

export interface ProviderCacheV2 {
  read(target: CacheV2Target): CacheV2ReadResult;
  write(target: CacheV2Target, snapshot: StandardUsageProvider): CacheV2WriteResult;
  dispose(): void;
}

export type ProviderCacheV2Options = Readonly<{ baseDir?: string }>;

type ValidatedTarget = Readonly<{
  providerId: string;
  generation: number;
  credentialEpoch: number;
  scopeDigest: string | null;
}>;

type PersistedEnvelope = Readonly<{
  // Process-local generation and credential epochs are intentionally excluded.
  // Stable non-secret scope owns disk reuse; the Phase 7 caller gates writes.
  version: 2;
  providerId: string;
  scopeDigest: string;
  snapshot: StandardUsageProvider;
}>;

type JsonValidation = Readonly<{ ok: true; nodes: number }> | Readonly<{ ok: false }>;

export function createProviderCacheV2(options: ProviderCacheV2Options = {}): ProviderCacheV2 {
  const baseDir = options.baseDir ?? DEFAULT_BASE_DIR;
  const memory = new Map<string, StandardUsageProvider>();
  let disposed = false;
  return Object.freeze({
    read: (target: CacheV2Target): CacheV2ReadResult => disposed
      ? { status: "invalid", diagnostic: "cache-invalid-input" }
      : readEntry(baseDir, memory, target),
    write: (target: CacheV2Target, snapshot: StandardUsageProvider): CacheV2WriteResult => disposed
      ? { status: "rejected", diagnostic: "cache-invalid-input" }
      : writeEntry(baseDir, memory, target, snapshot),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      memory.clear();
    },
  });
}

function readEntry(
  baseDir: string,
  memory: Map<string, StandardUsageProvider>,
  target: CacheV2Target,
): CacheV2ReadResult {
  const validated = validateTarget(baseDir, target);
  if (!validated) return { status: "invalid", diagnostic: "cache-invalid-input" };
  const key = memoryKey(validated);
  const cached = memory.get(key);
  if (cached) return { status: "hit", snapshot: cloneFrozen(cached), storage: "memory" };
  if (!validated.scopeDigest) return { status: "miss", diagnostic: "cache-miss" };
  const persistent = readPersistent(baseDir, validated);
  if (persistent.status === "hit") memory.set(key, persistent.snapshot);
  return persistent;
}

function writeEntry(
  baseDir: string,
  memory: Map<string, StandardUsageProvider>,
  target: CacheV2Target,
  snapshot: StandardUsageProvider,
): CacheV2WriteResult {
  const validated = validateTarget(baseDir, target);
  if (!validated) return { status: "rejected", diagnostic: "cache-invalid-input" };
  const frozen = validateAndCloneSnapshot(snapshot, validated.providerId);
  if (!frozen) return { status: "rejected", diagnostic: "snapshot-invalid" };
  if (!validated.scopeDigest) {
    memory.set(memoryKey(validated), frozen);
    return { status: "written", storage: "memory" };
  }
  if (!writePersistent(baseDir, validated, frozen)) {
    return { status: "error", diagnostic: "cache-write-failed" };
  }
  memory.set(memoryKey(validated), frozen);
  return { status: "written", storage: "persistent" };
}

function validateTarget(baseDir: string, target: CacheV2Target): ValidatedTarget | null {
  if (!isTrustedBaseDir(baseDir) || !PROVIDER_ID_PATTERN.test(target.providerId)) return null;
  if (!isSafeCounter(target.generation) || !isSafeCounter(target.credentialEpoch)) return null;
  if (target.scope === null) return { ...target, scopeDigest: null };
  const canonical = canonicalScope(target.providerId, target.scope);
  if (!canonical) return null;
  return {
    providerId: target.providerId,
    generation: target.generation,
    credentialEpoch: target.credentialEpoch,
    scopeDigest: createHash("sha256").update(canonical).digest("hex"),
  };
}

function canonicalScope(providerId: string, scope: CacheScopeMetadata): string | null {
  if (!isSafeIdentity(scope.accountId, 512)) return null;
  if (!VARIANT_PATTERN.test(scope.credentialVariant) || hasSecretPattern(scope.credentialVariant)) return null;
  const entries = canonicalShape(scope.dataShape);
  if (!entries) return null;
  return JSON.stringify([
    providerId,
    CACHE_V2_SCHEMA_VERSION,
    scope.accountId,
    scope.credentialVariant,
    entries,
  ]);
}

function canonicalShape(shape: CacheDataShape): readonly (readonly [string, string | number | boolean])[] | null {
  if (!isPlainRecord(shape)) return null;
  const entries = Object.entries(shape);
  if (entries.length > 32) return null;
  const valid = entries.every(([key, value]) => isSafeShapeEntry(key, value));
  if (!valid) return null;
  return entries
    .map(([key, value]) => Object.freeze([key, value] as const))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

function isSafeShapeEntry(key: string, value: unknown): value is string | number | boolean {
  if (!SHAPE_KEY_PATTERN.test(key) || isSecretBearingKey(key) || looksDerivedCredentialKey(key)) return false;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && isSafeIdentity(value, 256);
}

function looksDerivedCredentialKey(key: string): boolean {
  return /(^|[._-])(hash|prefix|suffix|reference)($|[._-])/.test(key.toLowerCase());
}

function isSafeIdentity(value: string, maxLength: number): boolean {
  return value.length > 0
    && value.length <= maxLength
    && !containsControlCharacter(value)
    && !hasSecretPattern(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isSafeCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function memoryKey(target: ValidatedTarget): string {
  return JSON.stringify([
    target.providerId,
    target.credentialEpoch,
    target.scopeDigest,
  ]);
}

function isTrustedBaseDir(baseDir: string): boolean {
  if (!isAbsolute(baseDir)) return false;
  return isDescendantPath(resolve(tmpdir()), resolve(baseDir));
}

function isDescendantPath(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent.length > 0
    && pathFromParent !== ".."
    && !pathFromParent.startsWith(`..${sep}`)
    && !isAbsolute(pathFromParent);
}

function readPersistent(baseDir: string, target: ValidatedTarget): CacheV2ReadResult {
  const digest = target.scopeDigest;
  if (!digest) return { status: "miss", diagnostic: "cache-miss" };
  const filePath = persistentPath(baseDir, target.providerId, digest);
  try {
    lstatSync(filePath);
    assertPrivateDirectoryForRead(baseDir);
    const envelope = readEnvelope(filePath);
    if (!envelope) return { status: "invalid", diagnostic: "cache-invalid" };
    if (!matchesEnvelope(envelope, target.providerId, digest)) {
      return { status: "invalid", diagnostic: "cache-invalid" };
    }
    const snapshot = validateAndCloneSnapshot(envelope.snapshot, target.providerId);
    if (!snapshot) return { status: "invalid", diagnostic: "cache-invalid" };
    return { status: "hit", snapshot, storage: "persistent" };
  } catch (error: unknown) {
    return isMissingFileError(error)
      ? { status: "miss", diagnostic: "cache-miss" }
      : { status: "invalid", diagnostic: "cache-invalid" };
  }
}

function readEnvelope(filePath: string): PersistedEnvelope | null {
  const linkStat = lstatSync(filePath);
  if (!isPrivateRegularFile(linkStat)) return null;
  if (linkStat.size > MAX_FILE_BYTES) return null;
  const descriptor = openSync(filePath, constants.O_RDONLY | requiredNoFollowFlag());
  try {
    const openedStat = fstatSync(descriptor);
    if (!isPrivateRegularFile(openedStat) || openedStat.size > MAX_FILE_BYTES) return null;
    if (linkStat.dev !== openedStat.dev || linkStat.ino !== openedStat.ino) return null;
    const raw = readBoundedUtf8(descriptor);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedEnvelope(parsed) ? parsed : null;
  } finally {
    closeSync(descriptor);
  }
}

function readBoundedUtf8(descriptor: number): string | null {
  const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
  let totalBytes = 0;
  while (totalBytes < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, totalBytes, buffer.length - totalBytes, totalBytes);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
  }
  return totalBytes > MAX_FILE_BYTES ? null : buffer.toString("utf8", 0, totalBytes);
}

function assertPrivateDirectoryForRead(baseDir: string): void {
  assertCanonicalTrustedDirectory(baseDir);
  const status = lstatSync(baseDir);
  const privateMode = (status.mode & 0o777) === 0o700;
  if (!status.isDirectory() || status.isSymbolicLink() || !privateMode || !isOwnedByCurrentUser(status.uid)) {
    throw new Error("invalid cache directory");
  }
}

function isPrivateRegularFile(status: Readonly<{
  mode: number;
  uid: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}>): boolean {
  return status.isFile()
    && !status.isSymbolicLink()
    && (status.mode & 0o777) === 0o600
    && isOwnedByCurrentUser(status.uid);
}

function isOwnedByCurrentUser(uid: number): boolean {
  return typeof process.getuid !== "function" || uid === process.getuid();
}

function matchesEnvelope(envelope: PersistedEnvelope, providerId: string, digest: string): boolean {
  return envelope.version === CACHE_V2_SCHEMA_VERSION
    && envelope.providerId === providerId
    && envelope.scopeDigest === digest;
}

function isPersistedEnvelope(value: unknown): value is PersistedEnvelope {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 4
    && keys.every((key) => ["version", "providerId", "scopeDigest", "snapshot"].includes(key))
    && value.version === CACHE_V2_SCHEMA_VERSION
    && typeof value.providerId === "string"
    && typeof value.scopeDigest === "string"
    && isPlainRecord(value.snapshot);
}

function writePersistent(
  baseDir: string,
  target: ValidatedTarget,
  snapshot: StandardUsageProvider,
): boolean {
  const digest = target.scopeDigest;
  if (!digest) return false;
  let temporaryPath: string | null = null;
  try {
    ensurePrivateDirectory(baseDir);
    removeStaleTemporaryFiles(baseDir);
    const filePath = persistentPath(baseDir, target.providerId, digest);
    temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    const envelope: PersistedEnvelope = {
      version: CACHE_V2_SCHEMA_VERSION,
      providerId: target.providerId,
      scopeDigest: digest,
      snapshot,
    };
    writeAtomicFile(temporaryPath, filePath, JSON.stringify(envelope));
    temporaryPath = null;
    syncDirectory(baseDir);
    return true;
  } catch {
    if (temporaryPath) removeTemporaryFile(temporaryPath, true);
    return false;
  }
}

function ensurePrivateDirectory(baseDir: string): void {
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  assertCanonicalTrustedDirectory(baseDir);
  const status = lstatSync(baseDir);
  if (!status.isDirectory() || status.isSymbolicLink() || !isOwnedByCurrentUser(status.uid)) {
    throw new Error("invalid cache directory");
  }
  chmodSync(baseDir, 0o700);
}

function assertCanonicalTrustedDirectory(baseDir: string): void {
  const trustedRoot = realpathSync(tmpdir());
  const canonicalBaseDir = realpathSync(baseDir);
  if (!isDescendantPath(trustedRoot, canonicalBaseDir)) throw new Error("untrusted cache directory");
}

function writeAtomicFile(temporaryPath: string, filePath: string, content: string): void {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollowFlag();
  const descriptor = openSync(temporaryPath, flags, 0o600);
  try {
    fchmodSync(descriptor, 0o600);
    if (!isPrivateRegularFile(fstatSync(descriptor))) throw new Error("invalid temporary cache file");
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

function syncDirectory(baseDir: string): void {
  const descriptor = openSync(baseDir, constants.O_RDONLY | requiredNoFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeTemporaryFile(filePath: string, removeActive = false): void {
  try {
    const status = lstatSync(filePath);
    if (!isPrivateRegularFile(status)) return;
    if (!removeActive && !isStaleTemporaryFile(status.mtimeMs)) return;
    unlinkSync(filePath);
  } catch {
    return;
  }
}

function isStaleTemporaryFile(modifiedAt: number): boolean {
  return Date.now() - modifiedAt >= MAX_TEMPORARY_FILE_AGE_MS;
}

function removeStaleTemporaryFiles(baseDir: string): void {
  for (const name of readdirSync(baseDir)) {
    if (!TEMPORARY_FILE_PATTERN.test(name)) continue;
    removeTemporaryFile(join(baseDir, name));
  }
}

function persistentPath(baseDir: string, providerId: string, digest: string): string {
  return join(baseDir, `${providerId}-${digest}.json`);
}

function requiredNoFollowFlag(): number {
  const flag = Reflect.get(constants, "O_NOFOLLOW");
  if (typeof flag !== "number" || flag === 0) throw new Error("O_NOFOLLOW unavailable");
  return flag;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && Reflect.get(error, "code") === "ENOENT";
}

function validateAndCloneSnapshot(
  snapshot: StandardUsageProvider,
  providerId: string,
): StandardUsageProvider | null {
  const serialized = safelySerialize(snapshot);
  if (!serialized || Buffer.byteLength(serialized) > MAX_SNAPSHOT_BYTES) return null;
  if (!validateJsonValue(snapshot, 0, 0).ok) return null;
  if (!isSuccessfulSnapshot(snapshot, providerId)) return null;
  const cloned: unknown = JSON.parse(serialized);
  if (!isSuccessfulSnapshot(cloned, providerId)) return null;
  return deepFreeze(cloned);
}

function safelySerialize(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

function validateJsonValue(value: unknown, depth: number, nodes: number): JsonValidation {
  if (depth > MAX_VALUE_DEPTH || nodes >= MAX_VALUE_NODES) return { ok: false };
  if (value === null || typeof value === "boolean") return { ok: true, nodes: nodes + 1 };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, nodes: nodes + 1 } : { ok: false };
  if (typeof value === "string") {
    return hasSecretPattern(value) ? { ok: false } : { ok: true, nodes: nodes + 1 };
  }
  if (Array.isArray(value)) return validateJsonArray(value, depth, nodes + 1);
  if (isPlainRecord(value)) return validateJsonRecord(value, depth, nodes + 1);
  return { ok: false };
}

function validateJsonArray(values: readonly unknown[], depth: number, nodes: number): JsonValidation {
  let result: JsonValidation = { ok: true, nodes };
  for (const value of values) {
    if (!result.ok) return result;
    result = validateJsonValue(value, depth + 1, result.nodes);
  }
  return result;
}

function validateJsonRecord(value: Readonly<Record<string, unknown>>, depth: number, nodes: number): JsonValidation {
  let result: JsonValidation = { ok: true, nodes };
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretBearingKey(key) || !result.ok) return { ok: false };
    result = validateJsonValue(entry, depth + 1, result.nodes);
  }
  return result;
}

function isSecretBearingKey(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return looksSecretKey(key)
    || [
      "token", "secret", "credential", "password", "session", "cookie",
      "authorization", "privatekey", "clientsecret",
    ].some((fragment) => normalized.includes(fragment));
}

function isSuccessfulSnapshot(value: unknown, providerId: string): value is StandardUsageProvider {
  if (!isPlainRecord(value) || value.id !== providerId || !isSuccessStatus(value.status)) {
    return false;
  }
  if (!isBoundedString(value.displayName, 128) || !Array.isArray(value.windows)) return false;
  if (!value.windows.every(isUsageWindow) || !isPositiveFiniteNumber(value.fetchedAt)) return false;
  if (value.errorMessage !== undefined) return false;
  if (!isOptionalBoundedString(value.statusText, 1_024) || !isOptionalBoundedString(value.plan, 256)) return false;
  if (!isOptionalFiniteNumber(value.staleAt) || !isOptionalFiniteNumber(value.lastGoodAt)) return false;
  if (value.additionalProperties !== undefined && !isPlainRecord(value.additionalProperties)) return false;
  if (value.alerts !== undefined && (!Array.isArray(value.alerts) || !value.alerts.every(isUsageAlert))) return false;
  if (value.modelBreakdown !== undefined && (!Array.isArray(value.modelBreakdown) || !value.modelBreakdown.every(isModelBreakdown))) return false;
  return providerKeysAreKnown(value);
}

function isUsageWindow(value: unknown): value is StandardUsageWindow {
  if (!isPlainRecord(value)) return false;
  if (!isBoundedString(value.id, 256) || !isBoundedString(value.label, 256)) return false;
  if (typeof value.kind !== "string" || !WINDOW_KINDS.has(value.kind as StandardUsageWindow["kind"])) return false;
  if (!optionalNumbersAreFinite(value, [
    "percentage", "used", "limit", "remaining", "currentValue", "resetAt",
  ])) return false;
  if (!isOptionalBoundedString(value.unitLabel, 128)) return false;
  if (!isOptionalBoundedString(value.resetLabel, 512) || !isOptionalBoundedString(value.budgetLabel, 512)) return false;
  if (value.limitReached !== undefined && typeof value.limitReached !== "boolean") return false;
  if (value.severity !== undefined && !isSeverity(value.severity)) return false;
  if (value.additionalProperties !== undefined && !isPlainRecord(value.additionalProperties)) return false;
  if (!windowKeysAreKnown(value)) return false;
  return value.summaryDetails === undefined || isBoundedStringArray(value.summaryDetails, 512);
}

function isUsageAlert(value: unknown): value is StandardUsageAlert {
  return isPlainRecord(value)
    && isBoundedString(value.id, 256)
    && isBoundedString(value.label, 512)
    && isSeverity(value.severity)
    && (value.additionalProperties === undefined || isPlainRecord(value.additionalProperties))
    && keysAreAllowed(value, ["id", "label", "severity", "additionalProperties"]);
}

function isModelBreakdown(value: unknown): value is StandardModelBreakdown {
  return isPlainRecord(value)
    && isBoundedString(value.id, 256)
    && isBoundedString(value.label, 512)
    && optionalNumbersAreFinite(value, ["percentage", "used", "costUsd", "requests"])
    && isOptionalBoundedString(value.unitLabel, 128)
    && (value.severity === undefined || isSeverity(value.severity))
    && (value.additionalProperties === undefined || isPlainRecord(value.additionalProperties))
    && keysAreAllowed(value, [
      "id", "label", "percentage", "used", "unitLabel", "costUsd", "requests",
      "severity", "additionalProperties",
    ]);
}

function optionalNumbersAreFinite(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => isOptionalFiniteNumber(value[key]));
}

function isOptionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
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
    "limitReached", "severity", "summaryDetails", "additionalProperties",
  ]);
}

function keysAreAllowed(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function providerKeysAreKnown(value: Readonly<Record<string, unknown>>): boolean {
  const allowed = new Set([
    "id", "displayName", "status", "statusText", "plan", "windows", "alerts",
    "modelBreakdown", "additionalProperties", "fetchedAt", "staleAt", "lastGoodAt",
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneFrozen(snapshot: StandardUsageProvider): StandardUsageProvider {
  const serialized = JSON.stringify(snapshot);
  return deepFreeze(JSON.parse(serialized) as StandardUsageProvider);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}
