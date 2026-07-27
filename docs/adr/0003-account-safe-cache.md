# ADR 0003: Persist cache only with non-secret account identity

- Status: Accepted
- Date: 2026-07-27

## Context

Cache v1 is keyed only by provider ID. Changing credentials can therefore expose stale usage or balance data from another account.

Token values, hashes, prefixes, suffixes, decoded claims, environment names, and auth-entry names are not acceptable persistent account identities.

## Decision

Cache v2 persists a provider snapshot only when a stable non-secret account identity is available from trusted metadata before the cache read. Scope also includes provider ID, schema version, credential variant, and data-shaping provider options.

When safe identity is unavailable, use process-memory cache only. Credential resolution owns a process-local numeric epoch for request coalescing, but that epoch and all credential-derived state are never persisted.

Treat cache v1 as a cold miss. Do not migrate it.

## Consequences

- Environment-based credentials normally lose warm-start persistent cache.
- Account changes cannot reuse another account's persistent provider snapshot.
- Cache files use per-provider scope digests derived only from validated non-secret metadata.
