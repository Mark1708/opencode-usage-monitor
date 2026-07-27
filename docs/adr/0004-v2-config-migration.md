# ADR 0004: Use a v2-only runtime configuration

- Status: Accepted
- Date: 2026-07-27

## Context

The 1.x flat configuration mixes UI, refresh, provider visibility, provider options, and diagnostics. Supporting both schemas in the runtime would preserve central provider switches and make invalid configuration fallback unsafe.

## Decision

The 2.0 runtime accepts only configuration with `version: 2` and a required keyed `providers` object. Provider presence is the sole activation mechanism. Provider-specific refresh overrides are rejected; refresh policy is global.

When a v1 configuration is detected, fail closed with a sanitized actionable migration message. Do not silently apply defaults or mix schemas.

Offer a separate deterministic converter with dry-run and timestamped backup. It never moves credential values and never edits configuration implicitly during plugin startup.

## Consequences

- The release is semver-major.
- Structural configuration errors perform no auth, cache, scheduler, or network work.
- Legacy config/auth/cache APIs remain available only through the additive migration facade until the atomic Phase 8 runtime cutover.
