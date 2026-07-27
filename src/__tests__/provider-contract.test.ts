/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { LegacyAdapterFacade } from "../providers/contracts.js";
import { makeCtx } from "./_helpers.js";
import {
  makeFixtureBridge,
  makeFixtureDefinition,
} from "./_provider-contract-fixtures.js";

describe("provider definition contracts", () => {
  test("preserves local option types and reports parse success or failure", () => {
    const definition = makeFixtureDefinition();
    const success = definition.parseOptions({ region: "eu" });
    const failure = definition.parseOptions({ region: "" });

    expect(success.ok && success.value.region).toBe("eu");
    expect(failure.ok).toBe(false);
  });

  test("binds typed options through erased closures and owns presentation", async () => {
    const parsed = makeFixtureDefinition().registration.parseOptions({ region: "us" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const provider = await parsed.value.fetchUsage({
      credential: { secret: "test-value", source: "env", variant: "fixture", epoch: 1 },
      signal: new AbortController().signal,
      timeoutMs: 1000,
    });
    expect(provider.id).toBe("fixture-us");
    expect(parsed.value.present(provider).title).toBe("fixture:Fixture");
  });

  test("exposes only narrow non-secret account identifiers to cache metadata", () => {
    const parsed = makeFixtureDefinition().registration.parseOptions({ region: "apac" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    expect(parsed.value.resolveCacheScopeMetadata({
      readAccountIdentifier: (key) => key === "fixture-account" ? "account-1" : undefined,
    })).toEqual({
      accountId: "account-1",
      credentialVariant: "fixture",
      dataShape: { region: "apac" },
    });
  });
});

describe("LegacyAdapterFacade", () => {
  test("adapts a native registration for legacy consumers without invoking the presenter", async () => {
    const definition = makeFixtureDefinition("fixture", 90, () => { throw new Error("presenter must not run during fetch"); });
    const facade = new LegacyAdapterFacade(definition.registration, makeFixtureBridge());
    const context = makeCtx({}, { FIXTURE_API_KEY: "fixture-credential", FIXTURE_REGION: "eu" });

    expect(facade.id).toBe("fixture");
    expect(facade.displayName).toBe("Fixture");
    expect(facade.configKey).toBe("show_zai");
    expect(facade.isAvailable(context)).toBe(true);
    expect((await facade.fetchUsage(context, new AbortController().signal)).id).toBe("fixture-eu");
  });

  test("returns a standardized config error when native option parsing fails", async () => {
    const facade = new LegacyAdapterFacade(makeFixtureDefinition().registration, makeFixtureBridge());
    const context = makeCtx({}, { FIXTURE_API_KEY: "fixture-credential", FIXTURE_REGION: "" });
    const result = await facade.fetchUsage(context, new AbortController().signal);

    expect(result.status).toBe("error");
    expect(result.statusText).toContain("config error");
    expect(result.windows).toEqual([]);
  });

  test("returns missing-auth without parsing options or invoking provider fetch", async () => {
    const facade = new LegacyAdapterFacade(makeFixtureDefinition().registration, makeFixtureBridge());
    const result = await facade.fetchUsage(makeCtx(), new AbortController().signal);

    expect(result.status).toBe("missing-auth");
    expect(result.statusText).toBe("fixture credential missing");
    expect(result.windows).toEqual([]);
  });
});
