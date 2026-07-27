# ADR 0001: Exclude ChatGPT quota from the 2.0 catalog

- Status: Accepted
- Date: 2026-07-27

## Context

The 1.x OpenAI provider reads ChatGPT/Codex rolling quota windows from `https://chatgpt.com/backend-api/wham/usage`. The repository permits official provider APIs only.

OpenAI documents organization usage and costs APIs under `/v1/organization/usage/*` and `/v1/organization/costs`. Those APIs require an organization Admin API key and return historical token, request, and cost buckets. They do not return personal ChatGPT/Codex subscription percentages, rolling 5-hour/week windows, reset times, or limit-reached state.

The `wham/usage` endpoint is not present in OpenAI's public API reference or changelog and is described by third-party clients as an undocumented internal endpoint.

## Decision

Remove the current OpenAI ChatGPT/Codex quota provider from the 2.0 built-in catalog. Do not translate organization usage data into the existing quota view because the semantics are different.

A future `openai-platform` provider may use the documented organization usage/cost APIs with Admin API credentials and a purpose-built view.

## Consequences

- Version 2.0 initially ships Z.AI and DeepSeek providers.
- Existing OpenAI normalization fixtures remain only as 1.x compatibility evidence until the Phase 8 cutover removes the legacy runtime.
- Release verification rejects catalog entries without documented official API metadata.

## Evidence

- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions/
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs/
- https://developers.openai.com/api/docs/guides/admin-apis
