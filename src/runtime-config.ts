import { CONFIG_PATH, OMO_CONFIG_PATH } from "./config.js";
import type {
  ConfigTextReader,
  CredentialReferenceV2,
  DiagnosticsConfigV2,
  KeybindingsConfigV2,
  ReadUsageConfigV2Options,
  RefreshConfigV2,
  ResolvedProviderConfigV2,
  ResolvedUsageConfigV2,
  UiConfigV2,
} from "./config-types.js";
import { BUILTIN_PROVIDER_CATALOG } from "./providers/builtins.js";
import type {
  ProviderRegistration,
  ValidationIssue,
  ValidationResult,
} from "./providers/contracts.js";
import { looksSecretKey, sanitizeError } from "./sanitize.js";

export type {
  ConfigTextReader,
  ConfigTextResult,
  CredentialReferenceV2,
  DiagnosticsConfigV2,
  KeybindingsConfigV2,
  ProviderConfigV2,
  ReadUsageConfigV2Options,
  RefreshConfigV2,
  ResolvedDiagnosticsConfigV2,
  ResolvedKeybindingsConfigV2,
  ResolvedProviderConfigV2,
  ResolvedRefreshConfigV2,
  ResolvedUiConfigV2,
  ResolvedUsageConfigV2,
  UiConfigV2,
  UsageConfigV2,
} from "./config-types.js";

const ROOT_KEYS = ["version", "enabled", "keybindings", "ui", "refresh", "diagnostics", "providers"] as const;
const PROVIDER_KEYS = ["order", "credential", "options"] as const;
const V1_KEYS = [
  "default_collapsed",
  "default_provider_collapsed",
  "debug",
  "max_detail_lines",
  "max_model_lines",
  "max_windows",
  "refresh_keybind",
  "refresh_ms",
  "request_timeout_ms",
  "show_deepseek",
  "show_details",
  "show_openai",
  "show_zai",
  "symbols",
  "width",
  "zai_organization_id",
  "zai_project_id",
] as const;
const MIN_AUTOMATIC_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 86_400_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_STALE_AFTER_MS = 60_000;
const MAX_STALE_AFTER_MS = 604_800_000;
const MIN_WIDTH = 20;
const MAX_WIDTH = 120;
const MAX_PROVIDER_ORDER = 10_000;
const MAX_OPTIONS_DEPTH = 8;
const KEYBINDING_PATTERN = /^[\x20-\x7E]{1,64}$/;

const DEFAULTS = Object.freeze({
  enabled: true,
  keybindings: Object.freeze({ refresh_all: "<leader>q", refresh_provider: null }),
  ui: Object.freeze({
    width: 34,
    symbols: "unicode" as const,
    panel_initial_state: "expanded" as const,
    provider_initial_state: "collapsed" as const,
  }),
  refresh: Object.freeze({
    mode: "automatic" as const,
    interval_ms: 300_000,
    timeout_ms: 15_000,
    stale_after_ms: 600_000,
  }),
  diagnostics: Object.freeze({ debug: false }),
});

type JsonObject = Readonly<Record<string, unknown>>;

type StructuralProvider = Readonly<{
  registration: ProviderRegistration;
  order: number;
  credential?: CredentialReferenceV2;
  options: unknown;
}>;

type StructuralConfig = Readonly<{
  enabled: boolean;
  keybindings: KeybindingsConfigV2;
  ui: UiConfigV2;
  refresh: RefreshConfigV2;
  diagnostics: DiagnosticsConfigV2;
  providers: readonly StructuralProvider[];
}>;

export function parseUsageConfigV2(
  input: unknown,
  catalog: readonly ProviderRegistration[] = BUILTIN_PROVIDER_CATALOG,
): ValidationResult<ResolvedUsageConfigV2> {
  const structural = parseStructuralConfig(input, catalog);
  if (!structural.ok) return structural;
  return { ok: true, value: resolveConfig(structural.value) };
}

export async function readUsageConfigV2(
  options: ReadUsageConfigV2Options = {},
): Promise<ValidationResult<ResolvedUsageConfigV2>> {
  const readText = options.readText ?? readConfigText;
  const dedicated = await safelyRead(readText, options.dedicatedPath ?? CONFIG_PATH);
  if (!dedicated.ok) return dedicated;
  if (dedicated.value.exists) return parseConfigText(dedicated.value.text, "config");
  return readOmoConfig(readText, options.omoPath ?? OMO_CONFIG_PATH);
}

async function readOmoConfig(
  readText: ConfigTextReader,
  path: string,
): Promise<ValidationResult<ResolvedUsageConfigV2>> {
  const source = await safelyRead(readText, path);
  if (!source.ok) return source;
  if (!source.value.exists) return failure("config", "Usage monitor config file not found");
  const parsed = parseJson(source.value.text, "usage_monitor");
  if (!parsed.ok) return parsed;
  if (!isObject(parsed.value)) return failure("usage_monitor", "OMO config must be an object");
  const section = parsed.value.usage_monitor;
  if (section === undefined) return failure("usage_monitor", "usage_monitor config section is required");
  return parseUsageConfigV2(section);
}

async function safelyRead(
  readText: ConfigTextReader,
  path: string,
): Promise<ValidationResult<Awaited<ReturnType<ConfigTextReader>>>> {
  try {
    return { ok: true, value: await readText(path) };
  } catch (error: unknown) {
    return failure("config", `Unable to read config: ${sanitizeError(error)}`);
  }
}

async function readConfigText(path: string): Promise<Awaited<ReturnType<ConfigTextReader>>> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { exists: false };
  return { exists: true, text: await file.text() };
}

function parseConfigText(text: string, path: string): ValidationResult<ResolvedUsageConfigV2> {
  const parsed = parseJson(text, path);
  return parsed.ok ? parseUsageConfigV2(parsed.value) : parsed;
}

function parseJson(text: string, path: string): ValidationResult<unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return { ok: true, value: parsed };
  } catch (_error: unknown) {
    return failure(path, "Malformed JSON configuration");
  }
}

function parseStructuralConfig(
  input: unknown,
  catalog: readonly ProviderRegistration[],
): ValidationResult<StructuralConfig> {
  if (!isObject(input)) return failure("config", "Configuration must be an object");
  if (looksLikeV1(input)) return failure("version", "v1 config detected; migrate to version 2");
  const providerResult = parseProviders(input.providers, catalog);
  const issues = [
    ...unknownKeyIssues(input, ROOT_KEYS, ""),
    ...validateRootScalars(input),
    ...validateKeybindings(input.keybindings),
    ...validateUi(input.ui),
    ...validateRefresh(input.refresh),
    ...validateDiagnostics(input.diagnostics),
    ...(!providerResult.ok ? providerResult.issues : []),
  ];
  if (issues.length > 0) return failures(issues);
  if (!providerResult.ok) return providerResult;
  return { ok: true, value: buildStructuralConfig(input, providerResult.value) };
}

function validateRootScalars(input: JsonObject): readonly ValidationIssue[] {
  return [
    ...(input.version === 2 ? [] : [makeIssue("version", "version must equal 2")]),
    ...optionalTypeIssue(input.enabled, "boolean", "enabled"),
    ...(input.providers === undefined ? [makeIssue("providers", "providers is required")] : []),
  ];
}

function parseProviders(
  input: unknown,
  catalog: readonly ProviderRegistration[],
): ValidationResult<readonly StructuralProvider[]> {
  if (!isObject(input)) return failure("providers", "providers must be an object");
  const parsed = Object.entries(input).map(([id, value]) => parseProvider(id, value, catalog));
  const issues = parsed.flatMap((result) => result.ok ? [] : result.issues);
  if (issues.length > 0) return failures(issues);
  return { ok: true, value: Object.freeze(parsed.flatMap((result) => result.ok ? [result.value] : [])) };
}

function parseProvider(
  id: string,
  input: unknown,
  catalog: readonly ProviderRegistration[],
): ValidationResult<StructuralProvider> {
  const registration = catalog.find((candidate) => candidate.metadata.id === id);
  if (!registration) return failure(`providers.${id}`, "unknown provider id");
  if (!isObject(input)) return failure(`providers.${id}`, "provider config must be an object");
  const path = `providers.${id}`;
  const credential = parseCredential(input.credential, `${path}.credential`);
  const issues = [
    ...unknownKeyIssues(input, PROVIDER_KEYS, path),
    ...optionalIntegerRangeIssue(input.order, 0, MAX_PROVIDER_ORDER, `${path}.order`),
    ...(!credential.ok ? credential.issues : []),
    ...optionBoundaryIssues(input.options, `${path}.options`),
    ...(credential.ok && credential.value && !isAllowedCredentialReference(registration, credential.value)
      ? [makeIssue(`${path}.credential.source`, "credential reference is not allowed for this provider")]
      : []),
  ];
  if (issues.length > 0) return failures(issues);
  return {
    ok: true,
    value: Object.freeze({
      registration,
      order: typeof input.order === "number" ? input.order : registration.metadata.catalogOrder,
      ...(credential.ok && credential.value ? { credential: credential.value } : {}),
      options: input.options ?? {},
    }),
  };
}

function isAllowedCredentialReference(
  registration: ProviderRegistration,
  reference: CredentialReferenceV2,
): boolean {
  const name = reference.source === "env" ? reference.name : reference.entry;
  return registration.credentialPolicy.allowedSources.includes(reference.source)
    && registration.credentialPolicy.defaultCandidates.some(
      (candidate) => candidate.source === reference.source && candidate.name === name,
    );
}

function parseCredential(
  input: unknown,
  path: string,
): ValidationResult<CredentialReferenceV2 | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (!isObject(input)) return failure(path, "credential must be a reference object");
  if (input.source === "opencode") return parseOpencodeCredential(input, path);
  if (input.source === "env") return parseEnvCredential(input, path);
  return failure(`${path}.source`, "credential source must be opencode or env");
}

function parseOpencodeCredential(input: JsonObject, path: string): ValidationResult<CredentialReferenceV2> {
  const issues = [
    ...unknownKeyIssues(input, ["source", "entry"], path),
    ...referenceNameIssues(input.entry, `${path}.entry`, /^[A-Za-z0-9._-]+$/, "valid OpenCode entry"),
  ];
  if (issues.length > 0) return failures(issues);
  return { ok: true, value: Object.freeze({ source: "opencode", entry: readString(input.entry) }) };
}

function parseEnvCredential(input: JsonObject, path: string): ValidationResult<CredentialReferenceV2> {
  const issues = [
    ...unknownKeyIssues(input, ["source", "name"], path),
    ...referenceNameIssues(input.name, `${path}.name`, /^[A-Z][A-Z0-9_]{0,127}$/, "environment variable name"),
  ];
  if (issues.length > 0) return failures(issues);
  return { ok: true, value: Object.freeze({ source: "env", name: readString(input.name) }) };
}

function referenceNameIssues(
  input: unknown,
  path: string,
  pattern: RegExp,
  description: string,
): readonly ValidationIssue[] {
  if (typeof input !== "string" || input.length === 0 || input.length > 128) {
    return [makeIssue(path, `${description} is required`)];
  }
  if (input.includes("${") || !pattern.test(input)) return [makeIssue(path, `must be a ${description} without interpolation`)];
  return [];
}

function validateKeybindings(input: unknown): readonly ValidationIssue[] {
  if (input === undefined) return [];
  if (!isObject(input)) return [makeIssue("keybindings", "keybindings must be an object")];
  return [
    ...unknownKeyIssues(input, ["refresh_all", "refresh_provider"], "keybindings"),
    ...keybindingIssues(input.refresh_all, "keybindings.refresh_all"),
    ...keybindingIssues(input.refresh_provider, "keybindings.refresh_provider"),
  ];
}

function keybindingIssues(input: unknown, path: string): readonly ValidationIssue[] {
  if (input === undefined || input === null) return [];
  return typeof input === "string" && KEYBINDING_PATTERN.test(input)
    ? []
    : [makeIssue(path, "keybinding must be null or 1 to 64 printable single-line characters")];
}

function optionBoundaryIssues(
  input: unknown,
  path: string,
  depth = 0,
): readonly ValidationIssue[] {
  if (!Array.isArray(input) && !isObject(input)) return [];
  if (depth > MAX_OPTIONS_DEPTH) return [makeIssue(path, "options exceed maximum nesting depth")];
  if (Array.isArray(input)) {
    return input.flatMap((value, index) => optionBoundaryIssues(value, `${path}.${index}`, depth + 1));
  }
  return Object.entries(input).flatMap(([key, value]) => {
    const fieldPath = `${path}.${key}`;
    if (looksSecretKey(key)) return [makeIssue(fieldPath, "raw credential-like option field is not allowed")];
    return optionBoundaryIssues(value, fieldPath, depth + 1);
  });
}

function validateUi(input: unknown): readonly ValidationIssue[] {
  if (input === undefined) return [];
  if (!isObject(input)) return [makeIssue("ui", "ui must be an object")];
  return [
    ...unknownKeyIssues(input, ["width", "symbols", "panel_initial_state", "provider_initial_state"], "ui"),
    ...optionalIntegerRangeIssue(input.width, MIN_WIDTH, MAX_WIDTH, "ui.width"),
    ...optionalEnumIssue(input.symbols, ["unicode", "ascii"], "ui.symbols"),
    ...optionalEnumIssue(input.panel_initial_state, ["expanded", "collapsed"], "ui.panel_initial_state"),
    ...optionalEnumIssue(input.provider_initial_state, ["expanded", "collapsed"], "ui.provider_initial_state"),
  ];
}

function validateRefresh(input: unknown): readonly ValidationIssue[] {
  if (input === undefined) return [];
  if (!isObject(input)) return [makeIssue("refresh", "refresh must be an object")];
  const mode = input.mode ?? DEFAULTS.refresh.mode;
  const intervalMinimum = mode === "automatic" ? MIN_AUTOMATIC_INTERVAL_MS : 0;
  return [
    ...unknownKeyIssues(input, ["mode", "interval_ms", "timeout_ms", "stale_after_ms"], "refresh"),
    ...optionalEnumIssue(input.mode, ["automatic", "manual"], "refresh.mode"),
    ...optionalIntegerRangeIssue(input.interval_ms, intervalMinimum, MAX_INTERVAL_MS, "refresh.interval_ms"),
    ...optionalIntegerRangeIssue(input.timeout_ms, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, "refresh.timeout_ms"),
    ...optionalIntegerRangeIssue(input.stale_after_ms, MIN_STALE_AFTER_MS, MAX_STALE_AFTER_MS, "refresh.stale_after_ms"),
  ];
}

function validateDiagnostics(input: unknown): readonly ValidationIssue[] {
  if (input === undefined) return [];
  if (!isObject(input)) return [makeIssue("diagnostics", "diagnostics must be an object")];
  return [
    ...unknownKeyIssues(input, ["debug"], "diagnostics"),
    ...optionalTypeIssue(input.debug, "boolean", "diagnostics.debug"),
  ];
}

function resolveConfig(input: StructuralConfig): ResolvedUsageConfigV2 {
  const providers = Object.freeze(input.providers.map(resolveProvider).sort(compareResolvedProviders));
  return Object.freeze({
    version: 2,
    enabled: input.enabled,
    keybindings: Object.freeze({ ...DEFAULTS.keybindings, ...input.keybindings }),
    ui: Object.freeze({ ...DEFAULTS.ui, ...input.ui }),
    refresh: Object.freeze({ ...DEFAULTS.refresh, ...input.refresh }),
    diagnostics: Object.freeze({ ...DEFAULTS.diagnostics, ...input.diagnostics }),
    providers,
  });
}

function resolveProvider(input: StructuralProvider): ResolvedProviderConfigV2 {
  const parsed = input.registration.parseOptions(input.options);
  const common = {
    id: input.registration.metadata.id,
    order: input.order,
    registration: input.registration,
    ...(input.credential ? { credential: input.credential } : {}),
  };
  if (parsed.ok) return Object.freeze({ ...common, ok: true, binding: parsed.value });
  const issues = Object.freeze(parsed.issues.map((issue) => Object.freeze({
    path: `providers.${input.registration.metadata.id}.options.${sanitizeError(issue.path)}`,
    message: sanitizeError(issue.message),
  })));
  return Object.freeze({ ...common, ok: false, issues });
}

function compareResolvedProviders(left: ResolvedProviderConfigV2, right: ResolvedProviderConfigV2): number {
  return left.order - right.order
    || left.registration.metadata.catalogOrder - right.registration.metadata.catalogOrder
    || left.id.localeCompare(right.id);
}

function buildStructuralConfig(
  input: JsonObject,
  providers: readonly StructuralProvider[],
): StructuralConfig {
  return Object.freeze({
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
    keybindings: isObject(input.keybindings) ? input.keybindings : {},
    ui: isObject(input.ui) ? input.ui : {},
    refresh: isObject(input.refresh) ? input.refresh : {},
    diagnostics: isObject(input.diagnostics) ? input.diagnostics : {},
    providers,
  });
}

function unknownKeyIssues(
  input: JsonObject,
  allowed: readonly string[],
  parent: string,
): readonly ValidationIssue[] {
  return Object.keys(input)
    .filter((key) => !allowed.includes(key))
    .map((key) => makeIssue(parent ? `${parent}.${key}` : key, "unknown field"));
}

function optionalTypeIssue(
  input: unknown,
  expected: "boolean",
  path: string,
): readonly ValidationIssue[] {
  return input === undefined || typeof input === expected ? [] : [makeIssue(path, `must be a ${expected}`)];
}

function optionalEnumIssue(
  input: unknown,
  allowed: readonly string[],
  path: string,
): readonly ValidationIssue[] {
  return input === undefined || allowed.includes(typeof input === "string" ? input : "")
    ? []
    : [makeIssue(path, `must be one of ${allowed.join(", ")}`)];
}

function optionalIntegerRangeIssue(
  input: unknown,
  minimum: number,
  maximum: number,
  path: string,
): readonly ValidationIssue[] {
  if (input === undefined) return [];
  return typeof input === "number" && Number.isInteger(input) && input >= minimum && input <= maximum
    ? []
    : [makeIssue(path, `must be an integer between ${minimum} and ${maximum}`)];
}

function looksLikeV1(input: JsonObject): boolean {
  return input.version === 1 || (input.version === undefined && V1_KEYS.some((key) => key in input));
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readString(input: unknown): string {
  return typeof input === "string" ? input : "";
}

function makeIssue(path: string, message: string): ValidationIssue {
  return Object.freeze({ path: sanitizeError(path), message: sanitizeError(message) });
}

function failure<T>(path: string, message: string): ValidationResult<T> {
  return failures([makeIssue(path, message)]);
}

function failures<T>(issues: readonly ValidationIssue[]): ValidationResult<T> {
  return { ok: false, issues: Object.freeze([...issues]) };
}
