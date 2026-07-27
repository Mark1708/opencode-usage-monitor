import type {
  LegacyProviderBridge,
  ProviderDefinition,
  ValidationResult,
} from "../providers/contracts.js";
import { defineProvider } from "../providers/contracts.js";
import type { StandardUsageProvider } from "../providers/types.js";
import type { ProviderUsageView } from "../views/types.js";

type FixtureOptions = Readonly<{ region: string }>;

export function readyProvider(id: string, displayName = id): StandardUsageProvider {
  return { id, displayName, status: "ready", windows: [] };
}

export function makeFixtureDefinition(
  id = "fixture",
  catalogOrder = 90,
  presenter = fixturePresenter,
): ProviderDefinition<FixtureOptions> {
  return defineProvider<FixtureOptions>({
    metadata: {
      id,
      displayName: "Fixture",
      catalogOrder,
      officialApi: {
        baseUrls: ["https://api.example.test"],
        documentationUrl: "https://docs.example.test/usage",
        endpoints: [{ method: "GET", path: "/usage" }],
      },
    },
    credentialPolicy: {
      allowedSources: ["env"],
      defaultCandidates: [{ source: "env", variant: "fixture", name: "FIXTURE_API_KEY" }],
    },
    parseOptions: parseFixtureOptions,
    fetchUsage: async ({ options }) => readyProvider(`${id}-${options.region}`, "Fixture"),
    present: presenter,
    resolveCacheScopeMetadata: ({ options, metadata }) => {
      const accountId = metadata.readAccountIdentifier("fixture-account");
      return accountId ? { accountId, credentialVariant: "fixture", dataShape: { region: options.region } } : null;
    },
  });
}

export function makeFixtureBridge(): LegacyProviderBridge {
  return {
    configKey: "show_zai",
    resolve: (context, signal) => {
      const credential = context.env.FIXTURE_API_KEY;
      if (!credential) return { ok: false, status: "missing-auth", message: "fixture credential missing" };
      return {
        ok: true,
        options: { region: context.env.FIXTURE_REGION ?? "" },
        fetchContext: {
          credential: { secret: credential, source: "env", variant: "fixture", epoch: 0 },
          signal,
          timeoutMs: context.timeoutMs,
        },
      };
    },
  };
}

function fixturePresenter(provider: StandardUsageProvider): ProviderUsageView {
  return {
    id: provider.id,
    title: `fixture:${provider.displayName}`,
    status: "ready",
    metrics: [],
  };
}

function parseFixtureOptions(input: unknown): ValidationResult<FixtureOptions> {
  if (typeof input !== "object" || input === null || !("region" in input)) {
    return { ok: false, issues: [{ path: "region", message: "region is required" }] };
  }
  const region = Reflect.get(input, "region");
  if (typeof region !== "string" || region.length === 0) {
    return { ok: false, issues: [{ path: "region", message: "region must be a non-empty string" }] };
  }
  return { ok: true, value: { region } };
}
