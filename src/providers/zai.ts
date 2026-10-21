import { discoverZaiCredential } from "../auth.js";
import { hasSecretPattern, sanitizeCredentialError } from "../sanitize.js";
import { getWindowSeverity } from "../severity.js";
import { zaiProviderToView } from "../views/zai-view.js";
import {
  defineProvider,
  LegacyAdapterFacade,
  type LegacyProviderBridge,
  type ProviderFetchContext,
  type ValidationIssue,
  type ValidationResult,
} from "./contracts.js";
import { asRecord, createStatusProvider, createTimeoutController, normalizeEpochMs, readNumber, readString, slug } from "./shared.js";
import type { ProviderContext, StandardModelBreakdown, StandardUsageProvider, StandardUsageWindow } from "./types.js";

const QUOTA_PATH = "/api/monitor/usage/quota/limit";
const ZAI_BASE_URL = "https://api.z.ai";
const ZHIPU_BASE_URL = "https://open.bigmodel.cn";
const statusProvider = createStatusProvider("zai", "z.ai");
const ENTERPRISE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
export const ZAI_ENTERPRISE_ID_MAX_LENGTH = 128;

export type ZaiOptions = Readonly<{
  plan: "personal" | "enterprise";
  organizationId?: string;
  projectId?: string;
}>;

type ZaiLimit = {
  id: string;
  type: string;
  name?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  used?: number;
  limit?: number;
  remaining?: number;
  currentValue?: number;
  nextResetTime?: number;
  usageDetails?: StandardModelBreakdown[];
};

export const zaiProviderDefinition = defineProvider<ZaiOptions>({
  metadata: {
    id: "zai",
    displayName: "z.ai",
    catalogOrder: 20,
    officialApi: {
      baseUrls: [ZAI_BASE_URL, ZHIPU_BASE_URL],
      documentationUrl: "https://docs.z.ai/guides/overview/usage",
      endpoints: [
        { method: "GET", path: QUOTA_PATH },
        { method: "GET", path: `${QUOTA_PATH}?type=2` },
      ],
    },
  },
  credentialPolicy: {
    allowedSources: ["opencode", "env"],
    defaultCandidates: [
      { source: "opencode", variant: "zai", name: "zai-coding-plan" },
      { source: "opencode", variant: "zai", name: "zai" },
      { source: "opencode", variant: "zhipu", name: "zhipuai-coding-plan" },
      { source: "opencode", variant: "zhipu", name: "zhipuai" },
      { source: "opencode", variant: "zhipu", name: "zhipu" },
      { source: "env", variant: "zai", name: "ZAI_API_KEY" },
      { source: "env", variant: "zai", name: "ZAI_CODING_PLAN_API_KEY" },
      { source: "env", variant: "zhipu", name: "ZHIPU_API_KEY" },
      { source: "env", variant: "zhipu", name: "ZHIPUAI_API_KEY" },
    ],
  },
  parseOptions: parseZaiOptions,
  fetchUsage: fetchZaiUsage,
  present: zaiProviderToView,
  resolveCacheScopeMetadata: ({ options, metadata }) => {
    if (options.plan !== "enterprise" || !options.organizationId || !options.projectId) return null;
    const credentialVariant = metadata.readAccountIdentifier("credential_variant");
    if (!isZaiCredentialVariant(credentialVariant)) return null;
    return {
      accountId: JSON.stringify([options.organizationId, options.projectId]),
      credentialVariant,
      dataShape: { plan: "enterprise" },
    };
  },
});

const zaiLegacyBridge: LegacyProviderBridge = {
  configKey: "show_zai",
  isAvailable: () => true,
  resolve: resolveLegacyZaiContext,
};

export const zaiUsageAdapter = new LegacyAdapterFacade(
  zaiProviderDefinition.registration,
  zaiLegacyBridge,
);

async function fetchZaiUsage(context: ProviderFetchContext<ZaiOptions>): Promise<StandardUsageProvider> {
  if (context.signal.aborted) return statusProvider("error", "cancelled");
  if (!isZaiCredentialVariant(context.credential.variant)) {
    return statusProvider("error", "invalid credential variant");
  }
  const baseUrl = context.credential.variant === "zhipu" ? ZHIPU_BASE_URL : ZAI_BASE_URL;
  const path = context.options.plan === "enterprise" ? `${QUOTA_PATH}?type=2` : QUOTA_PATH;
  const headers = createZaiHeaders(context);

  const controller = createTimeoutController(context.timeoutMs, context.signal);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) return statusProvider("forbidden", "forbidden");
    if (!response.ok) return statusProvider("error", `api ${response.status}`);
    const raw: unknown = await response.json();
    const root = asRecord(raw);
    if (
      readNumber(root?.code) === 1000 &&
      readString(root?.msg) === "Authentication Failed"
    ) {
      return statusProvider("forbidden", "forbidden");
    }
    return normalizeZaiQuota(raw, baseUrl);
  } catch (error: unknown) {
    const message = context.signal.aborted
      ? "cancelled"
      : controller.signal.aborted
        ? "timeout"
        : sanitizeCredentialError(error, context.credential.secret);
    return statusProvider("error", message);
  } finally {
    controller.dispose();
  }
}

function createZaiHeaders(context: ProviderFetchContext<ZaiOptions>): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: context.credential.secret,
    Accept: "application/json",
  };
  if (context.options.plan !== "enterprise") return headers;
  return {
    ...headers,
    "Bigmodel-Organization": context.options.organizationId ?? "",
    "Bigmodel-Project": context.options.projectId ?? "",
  };
}

function resolveLegacyZaiContext(context: ProviderContext, signal: AbortSignal) {
  const credential = resolveLegacyZaiCredential(context);
  if (!credential.ok) return { ok: false as const, status: "missing-auth" as const, message: credential.message };
  const organizationId = resolveSetting(context.config.zai_organization_id, context.env.ZHIPU_ORGANIZATION_ID);
  const projectId = resolveSetting(context.config.zai_project_id, context.env.ZHIPU_PROJECT_ID);
  const enterprise = organizationId !== undefined && projectId !== undefined;
  return {
    ok: true as const,
    options: enterprise
      ? { plan: "enterprise", organization_id: organizationId, project_id: projectId }
      : { plan: "personal" },
    fetchContext: {
      credential: {
        secret: credential.secret,
        source: credential.source,
        variant: credential.variant,
        epoch: 0,
      },
      signal,
      timeoutMs: context.timeoutMs,
    },
  };
}

type LegacyZaiCredential =
  | Readonly<{ ok: true; secret: string; source: "opencode" | "env"; variant: "zai" | "zhipu" }>
  | Readonly<{ ok: false; message: string }>;

function resolveLegacyZaiCredential(context: ProviderContext): LegacyZaiCredential {
  const authCredential = discoverZaiCredential(context.auth, {});
  if ("token" in authCredential) return toLegacyZaiCredential(authCredential, "opencode");
  const envCredential = discoverZaiCredential({}, context.env);
  if ("token" in envCredential) return toLegacyZaiCredential(envCredential, "env");
  return { ok: false, message: envCredential.message };
}

function toLegacyZaiCredential(
  credential: Readonly<{ token: string; baseUrl: string }>,
  source: "opencode" | "env",
): LegacyZaiCredential {
  return {
    ok: true,
    secret: credential.token,
    source,
    variant: credential.baseUrl === ZHIPU_BASE_URL ? "zhipu" : "zai",
  };
}

function resolveSetting(configValue: string | undefined, envValue: string | undefined): string | undefined {
  if (typeof configValue === "string" && configValue.length > 0) return configValue;
  if (typeof envValue === "string" && envValue.length > 0) return envValue;
  return undefined;
}

function parseZaiOptions(input: unknown): ValidationResult<ZaiOptions> {
  const options = asOptionsObject(input);
  if (!options) return invalidOptions("options", "options must be an object");
  const unknownKey = Object.keys(options).find((key) => !["plan", "organization_id", "project_id"].includes(key));
  if (unknownKey) return invalidOptions(unknownKey, "unknown option");
  const plan = readOption(options, "plan") ?? "personal";
  if (plan !== "personal" && plan !== "enterprise") return invalidOptions("plan", "plan must be personal or enterprise");
  const organization = parseIdentifierOption(options, "organization_id");
  if (!organization.ok) return organization;
  const project = parseIdentifierOption(options, "project_id");
  if (!project.ok) return project;
  if (plan === "personal" && (organization.present || project.present)) {
    return invalidOptions("organization_id", "enterprise identifiers require enterprise plan");
  }
  const organizationId = organization.value;
  const projectId = project.value;
  if (plan === "enterprise" && (!organizationId || !projectId)) {
    return invalidOptions("organization_id", "enterprise plan requires organization_id and project_id");
  }
  return {
    ok: true,
    value: { plan, ...(organizationId ? { organizationId } : {}), ...(projectId ? { projectId } : {}) },
  };
}

type ParsedIdentifier =
  | Readonly<{ ok: false; issues: readonly ValidationIssue[] }>
  | Readonly<{ ok: true; present: boolean; value?: string }>;

function parseIdentifierOption(options: object, key: string): ParsedIdentifier {
  const present = Object.hasOwn(options, key);
  if (!present) return { ok: true, present: false };
  const value = readOption(options, key);
  if (!isSafeEnterpriseId(value)) {
    return {
      ok: false,
      issues: Object.freeze([{ path: key, message: `${key} must be a non-empty string` }]),
    };
  }
  return { ok: true, present: true, value };
}

function isSafeEnterpriseId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= ZAI_ENTERPRISE_ID_MAX_LENGTH
    && ENTERPRISE_ID_PATTERN.test(value)
    && !hasSecretPattern(value);
}

function asOptionsObject(input: unknown): object | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input) ? input : undefined;
}

function readOption(options: object, key: string): unknown {
  return Reflect.get(options, key);
}

function isZaiCredentialVariant(value: string | undefined): value is "zai" | "zhipu" {
  return value === "zai" || value === "zhipu";
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
  const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
  return { ok: false, issues };
}

export function normalizeZaiQuota(raw: unknown, baseUrl: string = "https://api.z.ai", nowMs: number = Date.now()): StandardUsageProvider {
  const payload = extractPayload(raw);
  const plan = readString(payload.level);
  const limits = parseLimits(payload.limits);
  const windows = limits.flatMap((limit) => {
    const window = limitToWindow(limit);
    return window ? [window] : [];
  });
  const modelBreakdown = limits.flatMap((limit) => limit.usageDetails ?? []);
  const details = [
    plan
      ? { key: "plan", label: "plan", value: { kind: "text" as const, value: plan }, visibility: "detail" as const, priority: 100 }
      : undefined,
    ...modelBreakdown.flatMap((model, index) => {
      const value = model.used ?? model.percentage;
      return value === undefined
        ? []
        : [{
          key: `model-${model.id}`,
          label: model.label,
          value: { kind: "number" as const, value, unit: model.unitLabel ?? (model.used !== undefined ? "usage" : "%") },
          visibility: "detail" as const,
          priority: 70 - index,
        }];
    }),
    { key: "provider-base-url", label: "base url", value: { kind: "text" as const, value: baseUrl }, visibility: "debug" as const, priority: 1, tone: "muted" as const },
  ].filter((detail): detail is NonNullable<typeof detail> => detail !== undefined);
  return {
    id: "zai",
    displayName: "z.ai",
    status: windows.length > 0 ? "ready" : "partial",
    ...(windows.length === 0 ? { statusText: "partial data" } : {}),
    ...(plan ? { plan } : {}),
    windows,
    details,
    ...(modelBreakdown.length > 0 ? { modelBreakdown } : {}),
    fetchedAt: nowMs,
  };
}

function extractPayload(raw: unknown): Record<string, unknown> {
  const root = asRecord(raw) ?? {};
  return asRecord(root.data) ?? root;
}

function parseLimits(raw: unknown): ZaiLimit[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    const data = asRecord(entry);
    if (!data) return [];
    const type = readString(data.type) ?? readString(data.name) ?? `limit-${index + 1}`;
    return [{
      id: slug(`${type}-${readNumber(data.unit) ?? "u"}-${readNumber(data.number) ?? index}`),
      type,
      name: readString(data.name),
      unit: readNumber(data.unit),
      number: readNumber(data.number),
      percentage: readNumber(data.percentage),
      used: readFirstNumber(data.usage, data.used),
      limit: readFirstNumber(data.limit, data.total, data.quantity),
      remaining: readNumber(data.remaining),
      currentValue: readNumber(data.currentValue),
      nextResetTime: readNumber(data.nextResetTime),
      usageDetails: parseUsageDetails(data.usageDetails),
    } satisfies ZaiLimit];
  });
}

function limitToWindow(limit: ZaiLimit): StandardUsageWindow | undefined {
  const resetAt = normalizeEpochMs(limit.nextResetTime);
  const usage = usageForLimit(limit);
  if (!usage) return undefined;
  const standard = {
    id: `zai-${limit.id}`,
    label: labelForLimit(limit),
    kind: kindForLimit(limit),
    period: periodForLimit(limit),
    usage,
    ...(limit.percentage !== undefined ? { percentage: limit.percentage } : {}),
    ...(limit.used !== undefined ? { used: limit.used } : {}),
    ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
    ...(limit.remaining !== undefined ? { remaining: limit.remaining } : {}),
    ...(limit.currentValue !== undefined ? { currentValue: limit.currentValue } : {}),
    ...(resetAt !== undefined ? { resetAt } : {}),
    ...(limit.type === "TIME_LIMIT" && limit.limit !== undefined ? { budgetLabel: `${limit.limit}s budget` } : {}),
    ...(limit.type === "TOKENS_LIMIT" ? { unitLabel: "tokens" } : {}),
    ...(limit.remaining === 0 || (limit.percentage ?? 0) >= 100 ? { limitReached: true } : {}),
  } satisfies StandardUsageWindow;
  return { ...standard, severity: getWindowSeverity(standard) };
}

function usageForLimit(limit: ZaiLimit) {
  const unit = unitForLimit(limit);
  if (limit.used !== undefined && limit.limit !== undefined && limit.limit > 0) {
    return { kind: "quota" as const, used: limit.used, limit: limit.limit, unit };
  }
  if (limit.percentage !== undefined) return { kind: "percent" as const, usedPercent: limit.percentage };
  return undefined;
}

function periodForLimit(limit: ZaiLimit) {
  if (limit.unit === 3 && limit.number) return { kind: "rolling" as const, durationMs: limit.number * 60 * 60 * 1000 };
  if (limit.unit === 6 && limit.number === 1) return { kind: "calendar" as const, unit: "week" as const };
  if (limit.unit === 5 && limit.number === 1) return { kind: "calendar" as const, unit: "month" as const };
  return { kind: "unknown" as const };
}

function unitForLimit(limit: ZaiLimit): string {
  if (limit.type === "TIME_LIMIT") return "seconds";
  if (limit.type === "TOKENS_LIMIT") return "tokens";
  return "units";
}

function parseUsageDetails(raw: unknown): StandardModelBreakdown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const details = raw.flatMap((entry) => {
    const data = asRecord(entry);
    const modelCode = data ? readString(data.modelCode) ?? readString(data.model) : undefined;
    if (!data || !modelCode) return [];
    const percentage = readNumber(data.percentage);
    const used = readFirstNumber(data.usage, data.used);
    const unitLabel = readString(data.unitLabel);
    const requests = readNumber(data.requests);
    const costUsd = readNumber(data.costUsd);
    return [{
      id: slug(modelCode),
      label: modelCode,
      ...(percentage !== undefined ? { percentage } : {}),
      ...(used !== undefined ? { used } : {}),
      ...(unitLabel !== undefined ? { unitLabel } : {}),
      ...(requests !== undefined ? { requests } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    } satisfies StandardModelBreakdown];
  });
  return details.length > 0 ? details : undefined;
}

function labelForLimit(limit: ZaiLimit): string {
  if (limit.unit === 3 && limit.number) return `${limit.number}h`;
  if (limit.unit === 6 && limit.number === 1) return "week";
  if (limit.unit === 5 && limit.number === 1) return "month";
  if (limit.type === "TOKENS_LIMIT") return limit.name ?? "tokens";
  return limit.name ?? limit.type.toLowerCase().replace(/_limit$/, "").replace(/_/g, "-");
}

function kindForLimit(limit: ZaiLimit): StandardUsageWindow["kind"] {
  if (limit.unit === 3) return "rolling";
  if (limit.unit === 6) return "weekly";
  if (limit.unit === 5) return "monthly";
  if (limit.type === "TOKENS_LIMIT") return "tokens";
  if (limit.type === "RATE_LIMIT" || limit.type === "TIMES_LIMIT") return "requests";
  return "unknown";
}

function readFirstNumber(...values: unknown[]): number | undefined {
  return values.map(readNumber).find((value) => value !== undefined);
}
