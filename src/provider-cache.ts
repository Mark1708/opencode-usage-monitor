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
import type { StandardUsageProvider } from "./providers/types.js";
import { hasSecretPattern } from "./sanitize.js";
import { isSecretBearingKey, validateAndCloneUsageSnapshot } from "./snapshot-validation.js";

export const CACHE_V2_SCHEMA_VERSION = 2;

const DEFAULT_BASE_DIR = join(tmpdir(), "opencode-usage-monitor-v2");
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TEMPORARY_FILE_AGE_MS = 5 * 60 * 1_000;
const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ACCOUNT_SCOPE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VARIANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SHAPE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const TEMPORARY_FILE_PATTERN = /^[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}\.json\.tmp-[A-Za-z0-9-]+$/;

export type CacheV2Target = Readonly<{
  providerId: string;
  generation: number;
  credentialEpoch: number;
  accountScope: string;
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
  accountScope: string;
  scopeDigest: string | null;
}>;

export type ValidatedCacheScope = Readonly<{
  scope: CacheScopeMetadata;
  canonical: string;
  identity: string;
}>;

type PersistedEnvelope = Readonly<{
  // Process-local generation and credential epochs are intentionally excluded.
  // Stable non-secret scope owns disk reuse; the Phase 7 caller gates writes.
  version: 2;
  providerId: string;
  scopeDigest: string;
  snapshot: StandardUsageProvider;
}>;


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
  const validation = validateAndCloneUsageSnapshot(snapshot, validated.providerId);
  if (!validation.ok) return { status: "rejected", diagnostic: "snapshot-invalid" };
  const frozen = validation.snapshot;
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
  try {
    if (!isTrustedBaseDir(baseDir) || !PROVIDER_ID_PATTERN.test(target.providerId)) return null;
    if (!isSafeCounter(target.generation) || !isSafeCounter(target.credentialEpoch)) return null;
    if (!ACCOUNT_SCOPE_PATTERN.test(target.accountScope)) return null;
    if (target.scope === null) return { ...target, scopeDigest: null };
    const validatedScope = validateCacheScope(target.providerId, target.scope);
    if (!validatedScope) return null;
    return {
      providerId: target.providerId,
      generation: target.generation,
      credentialEpoch: target.credentialEpoch,
      accountScope: target.accountScope,
      scopeDigest: createHash("sha256").update(validatedScope.canonical).digest("hex"),
    };
  } catch (_error: unknown) {
    return null;
  }
}

export function validateCacheScope(providerId: string, value: unknown): ValidatedCacheScope | null {
  try {
    if (!PROVIDER_ID_PATTERN.test(providerId) || !isPlainRecord(value)) return null;
    const fields = readDataProperties(value, ["accountId", "credentialVariant", "dataShape"]);
    if (!fields) return null;
    const { accountId, credentialVariant, dataShape } = fields;
    if (typeof accountId !== "string" || !isSafeIdentity(accountId, 512)) return null;
    if (typeof credentialVariant !== "string" || !VARIANT_PATTERN.test(credentialVariant)) return null;
    if (hasSecretPattern(credentialVariant)) return null;
    const shape = canonicalShape(dataShape);
    if (!shape) return null;
    const detachedScope = Object.freeze({ accountId, credentialVariant, dataShape: shape.dataShape });
    const canonical = JSON.stringify([
      providerId, CACHE_V2_SCHEMA_VERSION, accountId, credentialVariant, shape.entries,
    ]);
    return Object.freeze({ scope: detachedScope, canonical, identity: canonical });
  } catch (_error: unknown) {
    return null;
  }
}

function canonicalShape(shape: unknown): Readonly<{
  dataShape: CacheDataShape;
  entries: readonly (readonly [string, string | number | boolean])[];
}> | null {
  if (!isPlainRecord(shape)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(shape);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) return null;
  const entries = Object.entries(descriptors);
  if (entries.length > 32) return null;
  const values = entries.map(([key, descriptor]) => [key, dataPropertyValue(descriptor)] as const);
  if (!values.every(([key, value]) => isSafeShapeEntry(key, value))) return null;
  const safeValues = values.flatMap(([key, value]) => isSafeShapeEntry(key, value)
    ? [Object.freeze([key, value] as const)]
    : []);
  const sorted = safeValues
    .map(([key, value]) => Object.freeze([key, value] as const))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.freeze({ dataShape: Object.freeze(Object.fromEntries(sorted)), entries: Object.freeze(sorted) });
}

function readDataProperties(
  value: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
    return null;
  }
  const properties = keys.flatMap((key) => typeof key === "string"
    ? [[key, dataPropertyValue(descriptors[key])] as const]
    : []);
  return properties.some(([, property]) => property === INVALID_PROPERTY)
    ? null
    : Object.freeze(Object.fromEntries(properties));
}

const INVALID_PROPERTY = Symbol("invalid-property");

function dataPropertyValue(descriptor: PropertyDescriptor | undefined): unknown {
  return descriptor?.enumerable && "value" in descriptor ? descriptor.value : INVALID_PROPERTY;
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
  return target.scopeDigest === null
    ? JSON.stringify([target.providerId, target.accountScope, target.credentialEpoch])
    : JSON.stringify([target.providerId, target.scopeDigest]);
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
    const validation = validateAndCloneUsageSnapshot(envelope.snapshot, target.providerId);
    if (!validation.ok) return { status: "invalid", diagnostic: "cache-invalid" };
    return { status: "hit", snapshot: validation.snapshot, storage: "persistent" };
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
