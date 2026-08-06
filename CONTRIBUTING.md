# Contributing to pi-agent-plugins

Thanks for helping improve `pi-agent-plugins`. Contributions to code, tests, documentation, examples, and conformance analysis are welcome.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before opening an issue

- Search existing issues and pull requests for related work.
- Use `/plugin doctor` when reporting plugin discovery or MCP projection problems.
- Remove secrets, access tokens, private URLs, and personal data from logs and examples.
- For security vulnerabilities, do not open a public issue. Use GitHub's private security-reporting tools when available or contact the maintainer through the [BlockedPath GitHub profile](https://github.com/BlockedPath).

## Development setup

Requirements:

- Node.js 20 or newer
- npm
- Pi 0.84 or newer for manual extension testing
- `pi-mcp-adapter` for end-to-end MCP testing

Clone and validate the project:

```bash
git clone https://github.com/BlockedPath/pi-agent-plugins.git
cd pi-agent-plugins
npm install
npm run typecheck
npm test
```

For a one-off Pi development run:

```bash
pi -e ./extensions/index.ts
```

## Making changes

1. Fork the repository and create a focused branch from `main`.
2. Keep each pull request limited to one coherent change.
3. Add or update tests for behavior changes and bug fixes.
4. Update the README, `CONFORMANCE.md`, or examples when behavior or documented support changes.
5. Run the required validation locally.
6. Open a pull request using the repository template.

Do not bump the package version or create release tags in a normal pull request. Maintainers handle releases after changes are merged.

## Code expectations

- Preserve existing TypeScript and formatting conventions.
- Prefer narrow validation and failure boundaries over broad catch-and-ignore behavior.
- Keep portable Agent Plugins behavior separate from Pi-specific client policy.
- Treat plugin manifests, skills, MCP configuration, paths, and process arguments as untrusted input.
- Do not weaken filesystem-resolved containment, trust isolation, managed-config ownership, or literal stdio launch semantics.
- Avoid new runtime dependencies unless the benefit and security impact are clear.

## Standards-sensitive changes

This project implements the published Agent Plugins 1.0.0 and Agent Skills specifications. A change affecting portable semantics should include:

- the relevant specification section
- a conformance rationale
- positive and negative test cases
- documentation of any client limitation or Pi-specific extension

Do not infer normative requirements from governance documents, future-considerations documents, or reference implementations when they conflict with the published specification text.

## Required validation

Run these commands before submitting a pull request:

```bash
npm run typecheck
npm test
npm pack --dry-run
```

Confirm that:

- the test suite passes
- the package contains all required runtime files
- no generated tarball, credentials, or local state is committed
- `git diff --check` reports no whitespace errors

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) where practical:

```text
feat: support a new portable component
fix: preserve literal MCP argument values
docs: clarify plugin trust behavior
test: cover symlink escape handling
```

Use `!` or a `BREAKING CHANGE:` footer when a change intentionally breaks compatibility.

## Pull requests

A useful pull request includes:

- a concise problem statement
- the chosen approach and relevant trade-offs
- linked issues, if any
- tests and validation commands
- screenshots or terminal output for user-facing changes
- residual risks and known limitations

Maintainers may ask for changes to keep the implementation secure, portable, maintainable, and aligned with the published specifications.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](./LICENSE).
