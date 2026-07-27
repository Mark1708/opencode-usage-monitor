import { readOpenCodeEntry } from "./auth.js";
import type { CredentialReferenceV2 } from "./config-types.js";
import type {
  CredentialCandidate,
  CredentialLease,
  CredentialSource,
  NonSecretAccountMetadataReader,
  ProviderRegistration,
  ValidationIssue,
  ValidationResult,
} from "./providers/contracts.js";
import { hasSecretPattern, looksSecretKey } from "./sanitize.js";

type MaybePromise<T> = T | Promise<T>;

export interface OpenCodeCredentialSourceReader {
  readOpenCodeEntry(entry: string): MaybePromise<string | undefined>;
}

export interface EnvironmentCredentialSourceReader {
  readEnv(name: string): MaybePromise<string | undefined>;
}

export type CredentialSourceReaders = OpenCodeCredentialSourceReader & EnvironmentCredentialSourceReader;

export type CredentialResolution =
  | Readonly<{ ok: true; lease: CredentialLease }>
  | Readonly<{
      ok: false;
      kind: "missing" | "config" | "source" | "superseded";
      message: string;
      epoch: number;
    }>;

export interface CredentialResolver {
  resolve(
    registration: ProviderRegistration,
    reference?: CredentialReferenceV2,
  ): Promise<CredentialResolution>;
  dispose(): void;
}

type ResolvedState = Readonly<{
  status: "resolved";
  source: CredentialSource;
  variant: string;
  secret: string;
  epoch: number;
}>;

type UnavailableState = Readonly<{ status: "missing" | "source-error"; epoch: number }>;
type CredentialState = ResolvedState | UnavailableState;

type CandidateResolution =
  | Readonly<{ kind: "found"; candidate: CredentialCandidate; secret: string }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "source-error" }>;

const METADATA_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const METADATA_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;

export function createCredentialResolver(
  readers: CredentialSourceReaders = defaultCredentialSourceReaders(),
): CredentialResolver {
  let states = new Map<string, CredentialState>();
  let sequences = new Map<string, number>();
  let disposed = false;
  const resolve: CredentialResolver["resolve"] = async (registration, reference) => {
    if (disposed) return resolutionError("source", "Credential resolver is disposed", 0);
    const identity = referenceIdentity(registration.metadata.id, reference);
    const sequence = (sequences.get(identity) ?? 0) + 1;
    sequences = new Map(sequences).set(identity, sequence);
    const selection = selectCandidates(registration, reference);
    if (!selection.ok) return resolutionError("config", selection.message, states.get(identity)?.epoch ?? 0);
    const resolved = await resolveCandidates(selection.candidates, readers);
    if (sequences.get(identity) !== sequence) {
      return resolutionError("superseded", "Credential resolution was superseded", states.get(identity)?.epoch ?? 0);
    }
    if (resolved.kind === "source-error") {
      const next = nextUnavailableState(states.get(identity), "source-error");
      states = new Map(states).set(identity, next);
      return resolutionError("source", "Unable to read credential source", next.epoch);
    }
    const next = nextCredentialState(states.get(identity), resolved);
    states = new Map(states).set(identity, next);
    if (next.status !== "resolved") return resolutionError("missing", "Credential is missing", next.epoch);
    return Object.freeze({
      ok: true,
      lease: Object.freeze({
        secret: next.secret,
        source: next.source,
        variant: next.variant,
        epoch: next.epoch,
      }),
    });
  };
  const dispose = (): void => {
    disposed = true;
    states = new Map();
    sequences = new Map();
  };
  return Object.freeze({ resolve, dispose });
}

export function createNonSecretAccountMetadataReader(
  metadata: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): ValidationResult<NonSecretAccountMetadataReader> {
  const issue = validateMetadata(metadata, allowedKeys);
  if (issue) return { ok: false, issues: Object.freeze([issue]) };
  const selected = Object.freeze(Object.fromEntries(
    allowedKeys.flatMap((key) => typeof metadata[key] === "string" ? [[key, metadata[key]]] : []),
  ));
  return {
    ok: true,
    value: Object.freeze({
      readAccountIdentifier: (key: string) => allowedKeys.includes(key) ? selected[key] : undefined,
    }),
  };
}

function defaultCredentialSourceReaders(): CredentialSourceReaders {
  return Object.freeze({
    readOpenCodeEntry,
    readEnv: (name: string) => process.env[name],
  });
}

function selectCandidates(
  registration: ProviderRegistration,
  reference: CredentialReferenceV2 | undefined,
): Readonly<{ ok: true; candidates: readonly CredentialCandidate[] }> | Readonly<{ ok: false; message: string }> {
  const { allowedSources, defaultCandidates } = registration.credentialPolicy;
  if (defaultCandidates.some((candidate) => !allowedSources.includes(candidate.source))) {
    return { ok: false, message: "Credential policy is inconsistent" };
  }
  if (!reference) return { ok: true, candidates: defaultCandidates };
  if (!allowedSources.includes(reference.source)) {
    return { ok: false, message: "Credential reference is not allowed" };
  }
  const name = reference.source === "env" ? reference.name : reference.entry;
  const candidate = defaultCandidates.find((item) => item.source === reference.source && item.name === name);
  return candidate
    ? { ok: true, candidates: [candidate] }
    : { ok: false, message: "Credential reference is not allowed" };
}

async function resolveCandidates(
  candidates: readonly CredentialCandidate[],
  readers: CredentialSourceReaders,
): Promise<CandidateResolution> {
  for (const candidate of candidates) {
    const read = await readCandidate(candidate, readers);
    if (read.kind === "source-error") return read;
    if (read.kind === "found") return { ...read, candidate };
  }
  return { kind: "missing" };
}

async function readCandidate(
  candidate: CredentialCandidate,
  readers: CredentialSourceReaders,
): Promise<Readonly<{ kind: "found"; secret: string }> | Readonly<{ kind: "missing" | "source-error" }>> {
  try {
    const secret = candidate.source === "env"
      ? await readers.readEnv(candidate.name)
      : await readers.readOpenCodeEntry(candidate.name);
    return typeof secret === "string" && secret.length > 0 ? { kind: "found", secret } : { kind: "missing" };
  } catch (_error: unknown) {
    return { kind: "source-error" };
  }
}

function nextCredentialState(
  previous: CredentialState | undefined,
  resolved: Exclude<CandidateResolution, Readonly<{ kind: "source-error" }>>,
): CredentialState {
  if (resolved.kind === "missing") {
    return nextUnavailableState(previous, "missing");
  }
  if (sameCredential(previous, resolved)) return previous;
  return Object.freeze({
    status: "resolved",
    source: resolved.candidate.source,
    variant: resolved.candidate.variant,
    secret: resolved.secret,
    epoch: (previous?.epoch ?? 0) + 1,
  });
}

function nextUnavailableState(
  previous: CredentialState | undefined,
  status: UnavailableState["status"],
): UnavailableState {
  if (previous?.status === status) return previous;
  return Object.freeze({ status, epoch: (previous?.epoch ?? 0) + 1 });
}

function sameCredential(
  previous: CredentialState | undefined,
  resolved: Readonly<{ kind: "found"; candidate: CredentialCandidate; secret: string }>,
): previous is ResolvedState {
  return previous?.status === "resolved"
    && previous.source === resolved.candidate.source
    && previous.variant === resolved.candidate.variant
    && previous.secret === resolved.secret;
}

function referenceIdentity(providerId: string, reference: CredentialReferenceV2 | undefined): string {
  if (!reference) return JSON.stringify([providerId, "default"]);
  const name = reference.source === "env" ? reference.name : reference.entry;
  return JSON.stringify([providerId, "explicit", reference.source, name]);
}

function resolutionError(
  kind: "missing" | "config" | "source" | "superseded",
  message: string,
  epoch: number,
): CredentialResolution {
  return Object.freeze({ ok: false, kind, message, epoch });
}

function validateMetadata(
  metadata: Readonly<Record<string, unknown>>,
  allowedKeys: readonly string[],
): ValidationIssue | undefined {
  for (const key of allowedKeys) {
    if (!METADATA_KEY_PATTERN.test(key) || looksSecretKey(key)) return metadataIssue(key, "Metadata key is not allowed");
    const value = metadata[key];
    if (value !== undefined && (
      typeof value !== "string"
      || !METADATA_VALUE_PATTERN.test(value)
      || hasSecretPattern(value)
    )) {
      return metadataIssue(key, "Metadata value is invalid");
    }
  }
  return undefined;
}

function metadataIssue(key: string, message: string): ValidationIssue {
  const safeKey = METADATA_KEY_PATTERN.test(key) ? key : "metadata";
  return Object.freeze({ path: `metadata.${safeKey}`, message });
}
