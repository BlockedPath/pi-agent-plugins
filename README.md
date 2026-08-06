  [![CodeRabbit Pull Request
 Reviews](https://img.shields.io/coderabbit/prs/github/BlockedPath/pi-agent-plugins?utm
 _source=oss&utm_medium=github&utm_campaign=BlockedPath%2Fpi-agent-plugins&labelColor=1
 71717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)](https:/
 /coderabbit.ai)
   [![npm
 version](https://img.shields.io/npm/v/pi-agent-plugins)](https://www.npmjs.com/package
 /pi-agent-plugins)
   [![npm
 downloads](https://img.shields.io/npm/dm/pi-agent-plugins)](https://www.npmjs.com/pack
 age/pi-agent-plugins)
   [![License:
 MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/lice
 nses/MIT)
   [![GitHub
 stars](https://img.shields.io/github/stars/BlockedPath/pi-agent-plugins?style=social)]
 (https://github.com/BlockedPath/pi-agent-plugins/stargazers)
   [![PRs
 Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com
 /BlockedPath/pi-agent-plugins/pulls)

 [![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue)](https://www.typesc
 riptlang.org/)
   [![pi
 compatible](https://img.shields.io/badge/pi-Compatible-blueviolet)](https://pi.dev)
# pi-agent-plugins

![Agent Plugins gallery artwork](./assets/gallery.jpg)

An [Agent Plugins 1.0.0](https://agent-plugins.org/) client extension for the [Pi coding agent](https://pi.dev/).

It lets Pi load portable plugin directories containing:

- **Agent Skills** from immediate `skills/*/SKILL.md` children
- **MCP servers** from root `mcp.json`, using [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) as the MCP runtime
- Optional Pi-specific resources under the `dev.pi.agent` client-extension namespace

The loader implements the spec's closed schemas, filesystem containment, narrow component failure boundaries, plugin-variable expansion, persistent `PLUGIN_DATA`, and transport rules.

## Requirements

- Node.js 20+
- Pi 0.84+
- `pi-mcp-adapter` for MCP support

## Install

Install both required Pi packages. `pi-mcp-adapter` is the MCP runtime used by this extension and must be installed for plugin MCP servers to work:

```bash
pi install npm:pi-mcp-adapter
pi install npm:pi-agent-plugins
```

Installing only `pi-agent-plugins` enables portable skill discovery, but MCP servers remain unavailable until `pi-mcp-adapter` is installed.

Or install this package from GitHub after installing the same MCP requirement:

```bash
pi install npm:pi-mcp-adapter
pi install https://github.com/BlockedPath/pi-agent-plugins
```

From a local checkout:

```bash
npm install
npm test
pi install npm:pi-mcp-adapter
pi install /path/to/pi-agent-plugins
```

For a one-off development run:

```bash
pi -e /path/to/pi-agent-plugins/extensions/index.ts
```

## Plugin locations

The extension discovers immediate child directories containing `plugin.json`:

| Scope | Location | Policy |
| --- | --- | --- |
| User | `~/.pi/agent/plugins/<plugin>/plugin.json` | Available in all projects |
| Project | `<project>/.pi/plugins/<plugin>/plugin.json` | Loaded only after Pi trusts the project |

User and project plugins with the same manifest `name` are deduplicated; the project copy wins in that project.

Persistent state is kept outside package contents:

- `~/.pi/agent/plugin-data/<plugin>/` — user-plugin `PLUGIN_DATA`
- `~/.pi/agent/plugin-data/project/<plugin>-<instance>/` — project-plugin `PLUGIN_DATA`, isolated by resolved install root
- `~/.pi/agent/agent-plugins/state.json` — enablement and MCP trust decisions
- `~/.pi/agent/agent-plugins/managed-mcp.json` — user MCP projection ledger
- `<project>/.pi/agent-plugins-managed-mcp.json` — project MCP projection ledger

## Commands

```text
/plugin list
/plugin info <name>
/plugin install <source>
/plugin uninstall <name>
/plugin enable <name>
/plugin disable <name>
/plugin trust <name>
/plugin reload
/plugin doctor
```

Install sources:

```bash
/plugin install npm:@acme/tools@1.2.3
/plugin install github.com/acme/tools@v1.2.3
/plugin install https://github.com/acme/tools.git
/plugin install git:git@github.com:acme/tools.git@v1.2.3
/plugin install ./local-plugin
```

npm downloads use `npm pack --ignore-scripts`; package lifecycle scripts are not executed during installation. Git uses a shallow, non-interactive clone. Every source is staged and its root manifest is validated before it reaches the install directory.

`/plugin reload` reconciles MCP configuration, then invokes Pi's normal reload flow so skills and MCP runtime state refresh together.

## MCP trust model

A plugin can launch a process with the user's permissions. Discovery and validation therefore do **not** automatically activate MCP servers.

The extension asks for explicit trust once per installed plugin instance. A trusted user plugin never transfers trust or `PLUGIN_DATA` to a project plugin that reuses its manifest name. You can also run:

```bash
/plugin trust <name>
```

The trust command writes the projection and reloads Pi automatically. If trust was granted through the startup confirmation prompt instead, run `/reload` once.

Disabling or uninstalling a plugin removes only MCP entries recorded in the extension's managed ledger. User-authored MCP entries are preserved. An unreadable existing MCP config is never overwritten.

Project MCP servers are projected into `<project>/.pi/mcp.json`, not the global config, so they cannot leak into another working directory. User plugin servers are projected into `~/.pi/agent/mcp.json`.

## Portable plugin example

```text
hello-plugin/
├── plugin.json
├── skills/
│   └── greet/
│       └── SKILL.md
└── mcp.json
```

`plugin.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "hello-plugin",
  "version": "1.0.0",
  "description": "Greeting skill and tools"
}
```

`skills/greet/SKILL.md`:

```markdown
---
name: greet
description: Greet the user and offer help. Use when the user asks for a greeting.
---

Greet the user warmly and offer help.
```

`mcp.json`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "./bin/server",
      "args": ["--data", "${PLUGIN_DATA}"],
      "env": {
        "CONFIG": "${PLUGIN_ROOT}/config.json"
      },
      "cwd": "${PLUGIN_ROOT}"
    },
    "remote-tools": {
      "type": "streamable-http",
      "url": "https://tools.example.com/mcp"
    }
  }
}
```

Projected MCP server names are namespaced to avoid collisions:

```text
hello-plugin__local-tools
hello-plugin__remote-tools
```

MCP tools retain pi-mcp-adapter's normal tool naming, approval, OAuth, resource, prompt, tracing, and lifecycle behavior.

## Pi client extension namespace

Portable components remain in the fixed standard locations. Pi-only additions can be declared under `extensions["dev.pi.agent"]`:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "pi-enhanced-plugin",
  "extensions": {
    "dev.pi.agent": {
      "prompts": ["./prompts"],
      "themes": ["./themes"]
    }
  }
}
```

All declared paths must begin with `./` and remain within the filesystem-resolved plugin root. Other extension namespaces are ignored without validation, as required by Agent Plugins §8.1.

## Transport support

| Transport | Status | Notes |
| --- | --- | --- |
| `stdio` | Supported | Bare command or contained `./` executable; arguments are always separate |
| `streamable-http` | Supported without configured headers | OAuth remains client-managed by pi-mcp-adapter |
| legacy `sse` | Not supported | Optional in Agent Plugins 1.0.0; skipped with a diagnostic |

Legacy `sse` is deliberately skipped. Agent Plugins requires the declared transport for the **initial** connection attempt, while pi-mcp-adapter's URL connector begins with Streamable HTTP and only falls back to SSE for backwards compatibility. Treating an explicit `sse` entry as a generic URL would be non-conformant.

Remote entries with configured `headers` are also skipped. Agent Plugins prohibits forwarding those headers to a different origin through redirects. The installed MCP runtime does not expose a redirect-policy hook, and Node forwards custom headers across cross-origin redirects. Refusing the entry is safer than leaking package data. Headerless Streamable HTTP remains supported.

## Security and containment

- `plugin.json`, fixed component locations, discovered `SKILL.md`, bundled commands, and Pi-extension paths must remain inside the filesystem-resolved plugin root.
- Symlink, junction, and traversal escapes are rejected at the narrowest applicable failure boundary.
- `command` is one token. It is never shell-parsed or placeholder-expanded.
- Only `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` are expanded, once, in stdio `args`, `env` values, and `cwd`.
- Plugin config cannot set the reserved `PLUGIN_ROOT` or `PLUGIN_DATA` environment names.
- Non-loopback HTTP MCP endpoints must use HTTPS.
- Configured remote headers are validated as literal package data, but header-bearing servers are not activated until the MCP runtime can enforce cross-origin redirect isolation.

Review third-party plugin source before installing it. Skills can instruct the model to execute code, and trusted MCP servers run with the user's permissions.

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite covers manifest and MCP failure boundaries, strict Agent Skills validation, path/symlink containment, placeholder semantics, MCP projection, managed-config preservation, transport handling, and install-source parsing.

See [CONFORMANCE.md](./CONFORMANCE.md) for the section-by-section implementation map and known limitations.
