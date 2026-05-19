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

## Local testing in OpenCode

Build after each source change:

```bash
bun run build:all
```

Then test the built plugin with your local OpenCode setup. Keep local configuration and credentials out of commits.

## Release process

Maintainers handle releases. The `prepublishOnly` script builds the plugin before publishing.

## License

By contributing to this project, you agree that your contributions will be licensed under the MIT License.
