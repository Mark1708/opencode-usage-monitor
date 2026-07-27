import { deepseekProviderToView } from "../views/deepseek-view.js";
import { zaiProviderToView } from "../views/zai-view.js";
import {
  defineProvider,
  type ProviderRegistration,
  type ValidationIssue,
  type ValidationResult,
} from "./contracts.js";

type ZaiOptions = Readonly<{
  plan: "personal" | "enterprise";
  organizationId?: string;
  projectId?: string;
}>;

type DeepseekOptions = Readonly<Record<string, never>>;

const zaiDefinition = defineProvider<ZaiOptions>({
  metadata: {
    id: "zai",
    displayName: "z.ai",
    catalogOrder: 20,
    officialApi: {
      baseUrl: "https://api.z.ai",
      documentationUrl: "https://docs.z.ai/guides/overview/usage",
      endpoints: [{ method: "GET", path: "/api/monitor/usage/quota/limit" }],
    },
  },
  credentialPolicy: {
    allowedSources: ["opencode", "env"],
    defaultCandidates: [
      { source: "opencode", variant: "zai", name: "zai" },
      { source: "env", variant: "zai", name: "ZAI_API_KEY" },
      { source: "env", variant: "zhipu", name: "ZHIPU_API_KEY" },
    ],
  },
  parseOptions: parseZaiOptions,
  fetchUsage: () => unavailableFetch("zai"),
  present: zaiProviderToView,
  resolveCacheScopeMetadata: () => null,
});

const deepseekDefinition = defineProvider<DeepseekOptions>({
  metadata: {
    id: "deepseek",
    displayName: "deepseek",
    catalogOrder: 30,
    officialApi: {
      baseUrl: "https://api.deepseek.com",
      documentationUrl: "https://api-docs.deepseek.com/api/get-user-balance",
      endpoints: [{ method: "GET", path: "/user/balance" }],
    },
  },
  credentialPolicy: {
    allowedSources: ["opencode", "env"],
    defaultCandidates: [
      { source: "opencode", variant: "deepseek", name: "deepseek" },
      { source: "env", variant: "deepseek", name: "DEEPSEEK_API_KEY" },
    ],
  },
  parseOptions: parseEmptyOptions,
  fetchUsage: () => unavailableFetch("deepseek"),
  present: deepseekProviderToView,
  resolveCacheScopeMetadata: () => null,
});

export const BUILTIN_PROVIDER_CATALOG = createProviderCatalog([
  zaiDefinition.registration,
  deepseekDefinition.registration,
]);

export function createProviderCatalog(
  registrations: readonly ProviderRegistration[],
): readonly ProviderRegistration[] {
  const ordered = [...registrations].sort(compareRegistrations);
  assertUniqueCatalogFields(ordered);
  return Object.freeze(ordered);
}

function compareRegistrations(left: ProviderRegistration, right: ProviderRegistration): number {
  return left.metadata.catalogOrder - right.metadata.catalogOrder
    || left.metadata.id.localeCompare(right.metadata.id);
}

function assertUniqueCatalogFields(registrations: readonly ProviderRegistration[]): void {
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const registration of registrations) {
    const { id, catalogOrder } = registration.metadata;
    if (ids.has(id)) throw new Error(`Duplicate provider id: ${id}`);
    if (orders.has(catalogOrder)) throw new Error(`Duplicate provider catalog order: ${catalogOrder}`);
    ids.add(id);
    orders.add(catalogOrder);
  }
}

function parseZaiOptions(input: unknown): ValidationResult<ZaiOptions> {
  const options = asOptionsObject(input);
  if (!options) return invalidOptions("options", "options must be an object");
  const unknownKey = Object.keys(options).find((key) => !["plan", "organization_id", "project_id"].includes(key));
  if (unknownKey) return invalidOptions(unknownKey, "unknown option");
  const plan = readOption(options, "plan") ?? "personal";
  if (plan !== "personal" && plan !== "enterprise") return invalidOptions("plan", "plan must be personal or enterprise");
  const organizationId = readOptionalString(readOption(options, "organization_id"));
  const projectId = readOptionalString(readOption(options, "project_id"));
  if (plan === "enterprise" && (!organizationId || !projectId)) {
    return invalidOptions("organization_id", "enterprise plan requires organization_id and project_id");
  }
  return {
    ok: true,
    value: { plan, ...(organizationId ? { organizationId } : {}), ...(projectId ? { projectId } : {}) },
  };
}

function parseEmptyOptions(input: unknown): ValidationResult<DeepseekOptions> {
  const options = asOptionsObject(input);
  if (!options) return invalidOptions("options", "options must be an object");
  const unknownKey = Object.keys(options)[0];
  return unknownKey ? invalidOptions(unknownKey, "unknown option") : { ok: true, value: Object.freeze({}) };
}

function asOptionsObject(input: unknown): object | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return input;
}

function readOption(options: object, key: string): unknown {
  return Reflect.get(options, key);
}

function readOptionalString(input: unknown): string | undefined {
  return typeof input === "string" && input.length > 0 ? input : undefined;
}

function invalidOptions<T>(path: string, message: string): ValidationResult<T> {
  const issues: readonly ValidationIssue[] = Object.freeze([{ path, message }]);
  return { ok: false, issues };
}

function unavailableFetch(providerId: string): Promise<never> {
  return Promise.reject(new Error(`${providerId} v2 fetch is not migrated`));
}
