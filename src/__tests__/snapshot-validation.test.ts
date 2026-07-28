/// <reference types="bun" />

import { describe, expect, test } from "bun:test";

import { validateAndCloneUsageSnapshot } from "../snapshot-validation.js";

const MAX_SNAPSHOT_BYTES = 256 * 1024;

function snapshot(padding: string) {
  return {
    id: "provider",
    displayName: "provider",
    status: "ready",
    windows: [],
    details: [
      ...Array.from({ length: 122 }, (_value, index) => ({
        key: `padding-${index}`,
        label: `padding ${index}`,
        value: { kind: "text" as const, value: "x".repeat(2_047) },
        visibility: "detail" as const,
      })),
      {
        key: "padding-final",
        label: "padding final",
        value: { kind: "text" as const, value: padding },
        visibility: "detail" as const,
      },
    ],
  };
}

describe("usage snapshot validation", () => {
  test("rejects a detached snapshot when fetchedAt pushes final JSON over the byte limit", () => {
    const padding = paddingForFinalOverflow();
    const result = validateAndCloneUsageSnapshot(snapshot(padding), "provider", { fetchedAt: 1_700_000_000_000 });

    expect(JSON.stringify(snapshot(padding)).length).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  test("keeps credential precedence before final byte-size invalidity", () => {
    const padding = paddingForFinalOverflow("secret-token");
    const result = validateAndCloneUsageSnapshot(snapshot(`secret-token${padding}`), "provider", {
      credential: "secret-token",
      fetchedAt: 1_700_000_000_000,
    });

    expect(result).toEqual({ ok: false, reason: "credential" });
  });

  test("rejects the active credential when it appears in a property key", () => {
    const credential = "active-credential-value";
    const result = validateAndCloneUsageSnapshot({
      id: "provider",
      displayName: "provider",
      status: "ready",
      windows: [],
      additionalProperties: { [`prefix-${credential}-suffix`]: "safe-value" },
      fetchedAt: 1,
    }, "provider", { credential });

    expect(result).toEqual({ ok: false, reason: "credential" });
  });

  test("rejects legacy additionalProperties after the provider contract cutover", () => {
    const result = validateAndCloneUsageSnapshot({
      id: "provider",
      displayName: "provider",
      status: "ready",
      windows: [],
      additionalProperties: { providerBaseUrl: "https://api.example.test" },
      fetchedAt: 1,
    }, "provider");

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  test("rejects excessive record keys before reading property descriptors", () => {
    let descriptorReads = 0;
    const keys = Array.from({ length: 5_001 }, (_value, index) => `key${index}`);
    const hostile = new Proxy({}, {
      ownKeys: () => keys,
      getOwnPropertyDescriptor: () => {
        descriptorReads += 1;
        return { configurable: true, enumerable: true, value: "x" };
      },
    });

    expect(validateAndCloneUsageSnapshot(hostile, "provider")).toEqual({ ok: false, reason: "invalid" });
    expect(descriptorReads).toBe(0);
  });

  test("rejects an excessive array length before reading element descriptors", () => {
    let descriptorReads = 0;
    const windows = new Proxy(new Array(5_001).fill(null), {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const result = validateAndCloneUsageSnapshot({
      id: "provider",
      displayName: "provider",
      status: "ready",
      windows,
      fetchedAt: 1,
    }, "provider");

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(descriptorReads).toBe(1);
  });

  test("rejects sparse arrays without iterating to array length", () => {
    let descriptorReads = 0;
    const windows = new Proxy(Object.assign([], { length: 1000000, 999999: null }), {
      getOwnPropertyDescriptor: (target, key) => {
        descriptorReads += 1;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const result = validateAndCloneUsageSnapshot({
      id: "provider",
      displayName: "provider",
      status: "ready",
      windows,
      fetchedAt: 1,
    }, "provider");

    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(descriptorReads).toBeLessThanOrEqual(1);
  });
});

function paddingForFinalOverflow(prefix = ""): string {
  for (let length = 0; length <= 2_048 - prefix.length; length += 1) {
    const padding = `${prefix}${"x".repeat(length)}`;
    const base = snapshot(padding);
    if (
      Buffer.byteLength(JSON.stringify(base)) <= MAX_SNAPSHOT_BYTES
      && Buffer.byteLength(JSON.stringify({ ...base, fetchedAt: 1_700_000_000_000 })) > MAX_SNAPSHOT_BYTES
    ) {
      return padding;
    }
  }
  throw new Error("Unable to construct final-size overflow fixture");
}
