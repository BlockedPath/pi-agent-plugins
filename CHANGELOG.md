# Changelog

## 0.1.4

- Add a Contributor Covenant code of conduct and contribution guidelines.
- Add structured bug-report and feature-request forms.
- Add a pull-request template with validation and compatibility checks.

## 0.1.3

- Add Last Commit, Issues, and Conventional Commits badges to the README.

## 0.1.2

- Remove the duplicated badge block from the README rendered on npm.
- Add `PROJECT_REFERENCE.md` as a durable architecture, operations, conformance, and release reference.

## 0.1.1

- Preserve portable stdio `args`, `env`, and `cwd` semantics through a client-owned launcher instead of exposing plugin values to pi-mcp-adapter interpolation and secret-command handling.
- Skip remote URLs whose literal value pi-mcp-adapter cannot preserve.
- Apply semantic path and runtime-support filtering during plugin discovery.
- Make qualified MCP server names injective for arbitrary JSON member names.
- Preserve special JSON object keys such as `__proto__` during validation.
- Reject unknown Agent Skills frontmatter fields and whitespace-only descriptions.
- Apply platform environment-name semantics, including case-insensitive replacement on Windows.
- Update conformance documentation for the Published v1.0.0 specification and its non-normative future considerations.

## 0.1.0

- Initial Agent Plugins 1.0.0 client release for Pi.
