# Contributing

Thank you for your interest in contributing to the usage-monitor plugin. This document provides guidelines for development contributions.

## Development setup

### Prerequisites

- [Bun](https://bun.sh/) >= 1.1.0
- [Node.js](https://nodejs.org/) >= 18.0.0 for compatibility with common tooling
- OpenCode >= v1.14.49 for local plugin testing

### Environment setup

```bash
git clone https://github.com/user/opencode-usage-monitor.git
cd opencode-usage-monitor
bun install
bun run build:all
bun test
bun run typecheck
```

## Development workflow

### Code style

- Follow existing patterns and conventions.
- No `as any`, `@ts-ignore`, or `@ts-expect-error`.
- File names use kebab-case (e.g., `openai-view.ts`).
- Use immutable data structures and avoid mutating existing objects.
- Keep functions small and focused.
- Keep files cohesive and below 800 lines.
- Avoid deep nesting; prefer early returns.
- Handle errors explicitly and sanitize user-facing error messages.
- Do not commit hardcoded secrets or credentials.
- Do not leave `console.log` statements in production code.

### Testing

- Write tests before implementing new behavior when practical.
- Maintain meaningful coverage for formatting, auth discovery, provider parsing, and configuration behavior.
- Run tests before submitting changes:

```bash
bun test
```

### Type checking and build

Run the full local validation set before opening a pull request:

```bash
bun run typecheck
bun run build:all
bun test
```

## Commit format

Use conventional commits:

```text
<type>: <description>

[optional body]
```

Common types:

- `feat`: New features
- `fix`: Bug fixes
- `refactor`: Code changes without new features or bug fixes
- `docs`: Documentation changes
- `test`: Adding or updating tests
- `chore`: Build process or auxiliary tool changes

Examples:

```text
feat: add compact quota display
fix: sanitize provider error messages
docs: update local installation instructions
refactor: split provider parsing helpers
```

## Pull request process

1. Fork the repository.
2. Create a focused branch from `main`.
3. Write or update tests for changed behavior.
4. Implement the change.
5. Run type checking, builds, and tests.
6. Update documentation when behavior or configuration changes.
7. Open a pull request with a clear summary and validation notes.

Use descriptive branch names:

```bash
git checkout -b feature/add-provider-status
git checkout -b fix/openai-error-handling
```

## Reporting issues

### Bug reports

Include:

1. Operating system and terminal details.
2. OpenCode version.
3. Bun version.
4. Plugin version or commit.
5. Configuration snippet with secrets removed.
6. Steps to reproduce.
7. Expected and actual behavior.
8. Relevant sanitized error messages.

### Feature requests

Include:

1. Use case description.
2. Expected behavior.
3. Provider or API constraints, if relevant.
4. Suggested implementation approach, if any.

## Code review guidelines

Review for:

- Readable, maintainable TypeScript.
- Correct OpenCode plugin and TUI integration.
- Reliable error handling and timeout behavior.
- Secret redaction in user-facing output.
- No hardcoded credentials.
- Updated tests and documentation.
- No significant performance regression.

## Local package verification

Build and verify the same package artifact used by CI:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:host
bun test
bun run build:all
bun run verify:package
```

The verifier writes `.artifacts/package.tgz` and exercises its public exports
from a clean consumer. Runtime testing must install that tarball into a
disposable OpenCode v2 wrapper; keep local configuration and credentials out of
commits.

## Release process

GitHub is the source of truth. Pull requests require the `Typecheck`, `Tests`,
and `Package` GitHub Actions jobs. Maintainers release by pushing a `vX.Y.Z`
tag that matches `package.json.version`. The release workflow reruns every
gate, publishes the exact verified `.artifacts/package.tgz` through npm Trusted
Publishing/OIDC, and attaches the tarball plus its SHA-256 digest to the GitHub
Release. `prepublishOnly` intentionally does not rebuild.

GitLab is maintained only as a read-only mirror.

## Language

Use English for all code comments, commit messages, issues, and pull request descriptions.

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
