# pi-agent-plugins project reference

_Last updated: 2026-08-06_

## Snapshot

| Item | Value |
| --- | --- |
| Package | `pi-agent-plugins` |
| Current release | `0.1.1` |
| License | MIT |
| Runtime | Node.js 20+, Pi 0.84+ |
| GitHub | <https://github.com/BlockedPath/pi-agent-plugins> |
| npm | <https://www.npmjs.com/package/pi-agent-plugins> |
| Pi gallery | <https://pi.dev/packages/pi-agent-plugins> |
| v0.1.1 release | <https://github.com/BlockedPath/pi-agent-plugins/releases/tag/v0.1.1> |
| Portable standard | Agent Plugins 1.0.0, status **Published** |
| MCP runtime | [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) |

This is a community-maintained Agent Plugins client for Pi, not an official release of the Agent Plugins specification project.

## Purpose

`pi-agent-plugins` lets Pi discover, validate, install, trust, and manage portable Agent Plugins. A portable plugin can provide:

- Agent Skills at immediate `skills/<name>/SKILL.md` directories
- MCP servers from root `mcp.json`
- optional Pi-specific prompts and themes through `extensions["dev.pi.agent"]`

Plugin sources can come from npm, Git, or local directories.

## Installation

Both Pi packages are required for skill and MCP support:

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-agent-plugins
```

Installing only `pi-agent-plugins` enables portable skill discovery, but plugin MCP servers require `pi-mcp-adapter`.

## User workflow

```text
/plugin list
/plugin install <source>
/plugin info <name>
/plugin trust <name>
/plugin enable <name>
/plugin disable <name>
/plugin uninstall <name>
/plugin reload
/plugin doctor
```

Example:

```text
/plugin install github.com/example/my-plugin
/plugin trust my-plugin
```

`/plugin trust` grants one installed plugin instance permission to activate its MCP servers and then reloads Pi.

## Portable plugin layout

```text
example-plugin/
├── plugin.json
├── skills/
│   └── example-skill/
│       └── SKILL.md
└── mcp.json
```

Minimal `plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-plugin"
}
```

Minimal `mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "tools": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.mjs"],
      "cwd": "${PLUGIN_ROOT}"
    }
  }
}
```

## Discovery and persistent state

| Scope | Plugin location |
| --- | --- |
| User | `~/.pi/agent/plugins/<plugin>/plugin.json` |
| Trusted project | `<project>/.pi/plugins/<plugin>/plugin.json` |

Persistent client state:

- `~/.pi/agent/plugin-data/<plugin>/` — user-plugin `PLUGIN_DATA`
- `~/.pi/agent/plugin-data/project/<plugin>-<instance>/` — isolated project-plugin data
- `~/.pi/agent/agent-plugins/state.json` — enablement and trust
- `~/.pi/agent/agent-plugins/managed-mcp.json` — user projection ledger
- `<project>/.pi/agent-plugins-managed-mcp.json` — project projection ledger

Project and user plugins that reuse a manifest name do not share trust or writable data.

## Architecture map

| File | Responsibility |
| --- | --- |
| `extensions/index.ts` | Pi extension entry point, resource discovery, trust prompt, and `/plugin` registration |
| `src/runtime.ts` | Runtime registry, user/project scanning, trust, and synchronization |
| `src/loader.ts` | Plugin and component discovery with failure boundaries |
| `src/manifest.ts` | Closed `plugin.json` validation |
| `src/skill.ts` | Agent Skills frontmatter validation |
| `src/mcp-config.ts` | Closed `mcp.json` and per-server validation |
| `src/mcp-runtime.ts` | Runtime compatibility, transport, command, and cwd checks |
| `src/mcp-bridge.ts` | Projection into pi-mcp-adapter configuration and managed reconciliation |
| `bin/stdio-launcher.mjs` | Literal-safe stdio launch and platform-correct environment overlay |
| `src/paths.ts` | Placeholder expansion and filesystem-resolved containment |
| `src/paths-client.ts` | User/project paths and per-instance `PLUGIN_DATA` |
| `src/install.ts` | npm, Git, local staging, validation, install, and uninstall |
| `src/plugin-command.ts` | `/plugin` command implementation |
| `CONFORMANCE.md` | Requirement-by-requirement standards map and known limitations |
| `CHANGELOG.md` | Release history |
| `RELEASING.md` | npm trusted-publishing and tagging procedure |

## Security and conformance decisions

- The canonical schemas are selected locally; they are not fetched while loading a plugin.
- Unknown root manifest fields are reported and ignored as required; other manifest schema failures reject the plugin.
- Filesystem-resolved containment rejects traversal, symlink, junction, and equivalent escapes at the narrowest required boundary.
- Skills are discovered only from immediate children of `skills/`.
- MCP entries are validated independently so one bad server does not disable valid siblings or skills.
- MCP execution requires explicit client-owned trust.
- Managed MCP reconciliation preserves user-authored pi-mcp-adapter configuration.
- `PLUGIN_ROOT` and `PLUGIN_DATA` are supplied by the client and cannot be overridden by plugin configuration.
- Placeholder expansion is single-pass and limited to `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in stdio `args`, env values, and `cwd`.
- A client-owned stdio launcher prevents pi-mcp-adapter from reinterpreting `${HOME}`, `$env:HOME`, `{env:HOME}`, or leading-`!` values.
- Environment overlay uses case-insensitive key equivalence on Windows and exact equivalence elsewhere.
- MCP server names use injective encoding so arbitrary JSON keys cannot collide.
- Null-prototype maps preserve special JSON keys such as `__proto__`.

## MCP transport profile

| Transport | Status |
| --- | --- |
| `stdio` | Supported |
| Headerless Streamable HTTP | Supported when the URL can remain literal |
| Streamable HTTP with configured headers | Skipped because cross-origin redirect header isolation cannot be enforced |
| URL containing `${NAME}`, `$env:NAME`, or `{env:NAME}` | Skipped because pi-mcp-adapter would expand it |
| Legacy HTTP+SSE | Unsupported and skipped |

OAuth discovery, interaction, approval, credential storage, tracing, and MCP lifecycle handling remain delegated to pi-mcp-adapter.

## Known standard boundaries

Agent Plugins v1 does not standardize:

- signatures or provenance attestations
- sandboxing or permission declarations
- portable secrets
- enterprise policy
- audit-event schemas
- dependencies between plugins
- a plugin test harness

The trust and management features in this project are Pi client policy, not portable manifest fields.

The Agent Skills website describes skill names as lowercase `a-z`, `0-9`, and hyphens, matching Pi. The current `skills-ref` implementation also accepts normalized Unicode names. This client follows the published textual constraint until the specification and host converge.

## Validation baseline

The `0.1.1` release was verified with:

- TypeScript typecheck
- 29 passing Node tests
- Knip checks
- npm package dry run containing the launcher, gallery image, and changelog
- LSP and security diagnostics
- the official MCP everything server through the projected stdio launcher
- expected MCP tools including `echo` and `get-sum`

Development commands:

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

## Release process

Normal release flow:

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
2. Run typecheck, tests, and package dry run.
3. Commit and push to `main`.
4. Configure npm trusted publishing for `.github/workflows/release.yml`.
5. Create and push the matching `v<version>` tag.
6. Verify npm, GitHub release, Pi gallery metadata, and installation from npm.

If GitHub Actions is unavailable, publish manually:

```bash
npm publish --access public
gh release create vX.Y.Z --verify-tag --generate-notes
```

Always confirm that the release tag points to the final tested commit before publishing. npm versions are immutable.

## Canonical references

- <https://agent-plugins.org/specification>
- <https://github.com/agentplugins/agent-plugins-spec>
- <https://github.com/agentplugins/agent-plugins-spec/blob/main/schemas/1.0.0/plugin.schema.json>
- <https://github.com/agentplugins/agent-plugins-spec/blob/main/schemas/1.0.0/mcp.schema.json>
- <https://agentskills.io/specification>
- <https://modelcontextprotocol.io/specification>

## Short showcase description

> `pi-agent-plugins` adds Agent Plugins 1.0.0 support to Pi. It installs and manages portable Agent Skills and MCP servers from npm, Git, or local paths with strict validation, explicit trust, isolated data, and filesystem containment.
