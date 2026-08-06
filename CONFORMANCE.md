# Agent Plugins 1.0.0 conformance

This document maps the Agent Plugins 1.0.0 requirements to the implementation. The normative specification remains authoritative and currently labels version 1.0.0 as a Working Draft.

## Client profile

- Supported Agent Plugins version: **1.0.0**
- Supported components: **Agent Skills and MCP servers**
- Supported MCP transports: **stdio and headerless Streamable HTTP**
- Optional legacy HTTP+SSE transport: **unsupported; entries are skipped and reported**
- Implemented client-extension namespace: **`dev.pi.agent`**
- MCP wire runtime: **pi-mcp-adapter**

## Plugin package and paths (§4)

- [x] A plugin is loaded from one directory root.
- [x] Root `plugin.json` is required.
- [x] The plugin root is filesystem-resolved.
- [x] Discovered and executed package paths are checked after resolving existing symlink prefixes.
- [x] Plugin-relative configuration paths must begin with `./`.
- [x] Traversal and symlink escapes are denied.
- [x] The narrow failure boundaries for manifest, component location, skill, and MCP entry escapes are applied.

Implementation: `src/paths.ts`, `src/loader.ts`

## Manifest (§5)

- [x] Root `plugin.json` loads before component discovery and client-specific behavior.
- [x] Only the canonical 1.0.0 `$schema` is recognized locally; schemas are never fetched while loading.
- [x] The closed field set is validated.
- [x] Unknown top-level fields are reported and ignored non-fatally.
- [x] A non-object `extensions` field is reported and ignored non-fatally.
- [x] Every other manifest schema violation rejects the plugin.
- [x] Required fields and all plugin-name constraints are checked.
- [x] Metadata uses the JSON-type-only semantics required by §5.4.
- [x] Unknown extension namespaces are ignored without validating their values.

Implementation: `src/manifest.ts`

## Component discovery (§6)

- [x] Skills are discovered only at `skills/`.
- [x] MCP configuration is discovered only at root `mcp.json`.
- [x] Missing locations are not errors.
- [x] A present location of the wrong filesystem kind invalidates only that component type.

Implementation: `src/loader.ts`, `src/mcp-config.ts`

## Agent Skills (§7.1)

- [x] Only immediate child directories containing a regular `SKILL.md` are considered.
- [x] Nested descendants are not recursively discovered.
- [x] `SKILL.md` containment is checked after symlink resolution.
- [x] YAML frontmatter, required fields, name constraints, parent-directory match, description length, compatibility, metadata, and allowed-tools types are validated against Agent Skills.
- [x] One invalid skill is skipped without affecting siblings or MCP servers.
- [x] Exact validated `SKILL.md` file paths are passed to Pi, avoiding Pi's recursive directory scan.

Implementation: `src/skill.ts`, `src/loader.ts`, `extensions/index.ts`

## MCP configuration (§7.2)

- [x] Only root `mcp.json` is loaded.
- [x] Top-level JSON, canonical `$schema`, version match, required fields, and closed shape are validated.
- [x] Top-level failure disables MCP only for that plugin.
- [x] Each server entry is independently validated against one closed transport variant.
- [x] Invalid and unsupported entries are skipped without affecting valid siblings or skills.
- [x] `command` is one bare token or one contained plugin-relative path.
- [x] `args` remain separate from `command`.
- [x] Omitted stdio `cwd` defaults to the plugin root.
- [x] Explicit `cwd` accepts only the three standard forms and enforces post-expansion containment.
- [x] Remote URLs are absolute HTTP(S), contain no user information or fragment, and require HTTPS off loopback.
- [x] Header names, values, and case-insensitive duplicate names are validated.
- [x] URL and headers remain literal.
- [x] Stdio and headerless Streamable HTTP are supported through pi-mcp-adapter.
- [x] Header-bearing remote entries are skipped because the runtime cannot enforce the required cross-origin redirect isolation.
- [x] Legacy `sse` is reported as unsupported and skipped.
- [x] Server names are qualified by plugin name to avoid host-table collisions.
- [x] Per-server runtime connection, authentication, and handshake failures remain isolated by pi-mcp-adapter.

Implementation: `src/mcp-config.ts`, `src/mcp-bridge.ts`

## Client extensions (§8)

- [x] Client-specific manifest data is read only from `extensions["dev.pi.agent"]`.
- [x] Unknown namespaces are ignored without validation.
- [x] Pi-native prompt and theme paths are contained plugin-relative paths.
- [ ] No file-only `dev.pi.agent/` directory behavior is currently defined. This is optional because a client may use manifest data, a directory, or both.

Implementation: `src/manifest.ts`, `extensions/index.ts`

## Environment and expansion (§9)

- [x] A dedicated writable `PLUGIN_DATA` directory is created and checked before launch.
- [x] Failure to prepare writable data skips only affected stdio entries while preserving independent HTTP entries.
- [x] User and project plugin instances with the same manifest name have separate `PLUGIN_DATA` directories.
- [x] `PLUGIN_DATA` lives outside package contents and persists across update/uninstall.
- [x] `PLUGIN_ROOT` is the absolute filesystem-resolved plugin root.
- [x] Configured env overlays the runtime base, then client-owned `PLUGIN_ROOT` and `PLUGIN_DATA` are set last by the projected server definition.
- [x] Plugin config cannot declare either reserved environment name.
- [x] Expansion is one non-recursive textual pass.
- [x] Only exact `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` occurrences expand.
- [x] Expansion occurs only in stdio `args`, env values, and `cwd`.
- [x] Env keys, `command`, URLs, headers, and fixed locations are not expanded.
- [x] Unknown placeholder-like text remains literal.

Implementation: `src/paths.ts`, `src/mcp-bridge.ts`

## Versioning (§10)

- [x] Canonical schema identifiers select local 1.0.0 rules.
- [x] `plugin.json` and `mcp.json` specification versions must match.
- [x] Arbitrary string plugin versions are accepted; SemVer is not required.

## Client conformance and resilience (§11)

- [x] Plugins load from directory paths.
- [x] Both standard component types are supported.
- [x] Both recommended MCP transports are supported.
- [x] Unsupported components and transports are isolated.
- [x] Independently valid components continue loading after failures.
- [x] Diagnostics are retained and exposed through `/plugin list`, `/plugin info`, and `/plugin doctor`.

## Client-policy features outside the portable standard

These behaviors are deliberately client-owned rather than represented as portable fields:

- User and project install roots
- npm, git, and local-path installation
- Explicit MCP execution trust keyed by installed plugin instance
- Enable/disable state
- Persistent-data placement
- MCP server host-name qualification
- Projection into pi-mcp-adapter global/project configuration
- `/plugin` command UX

## Known limitations

1. Legacy `type: "sse"` is not supported because pi-mcp-adapter cannot be instructed to select legacy HTTP+SSE for the initial connection. Skipping it is allowed by §7.2.1 and required by §7.2.2 when a declared transport is unsupported.
2. Remote entries with configured `headers` are validated but not activated. Agent Plugins forbids forwarding configured headers across an origin-changing redirect; pi-mcp-adapter currently exposes no redirect-policy hook, and Node forwards custom headers across such redirects. This is a runtime integration limitation rather than silently unsafe behavior.
3. Agent Plugins does not define portable credential references. Authentication discovery and storage use pi-mcp-adapter's client-managed behavior.
4. `/plugin trust` reloads Pi automatically. Trust granted from the startup confirmation prompt still requires one `/reload` because that event context cannot initiate Pi's reload flow.
