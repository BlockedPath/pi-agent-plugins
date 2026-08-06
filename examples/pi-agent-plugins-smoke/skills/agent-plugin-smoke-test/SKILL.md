---
name: agent-plugin-smoke-test
description: Verify that a portable Agent Plugin loaded correctly in Pi by checking this skill and calling the bundled official MCP everything test server. Use when testing pi-agent-plugins installation, skill discovery, MCP trust, or MCP tool connectivity.
license: MIT
compatibility: Requires Node.js, npx, network access for the first MCP server download, and pi-mcp-adapter.
metadata:
  source: pi-agent-plugins
  purpose: smoke-test
---

# Agent Plugin smoke test

Use this workflow to verify both portable component types.

## 1. Confirm skill loading

Tell the user: `Agent Skill loaded successfully.`

## 2. Confirm MCP discovery

Use the `mcp` gateway to list the server named `pi-agent-plugins-smoke__everything`:

```text
mcp({ server: "pi-agent-plugins-smoke__everything" })
```

If MCP reports `0/0 servers`, the current Pi session initialized before the generated config existed. Ask the user to run Pi's built-in `/reload` command (or restart Pi), then retry once. For other failures, inspect MCP status and report the exact startup error. The first launch can take longer because `npx` downloads the official `@modelcontextprotocol/server-everything` package.

## 3. Call real MCP tools

From the returned tool list:

1. Call the server's echo tool with `Agent Plugin MCP works`.
2. Call its add tool with `a = 20` and `b = 22`.
3. Verify that echo returns the same text and add returns `42`.

Use the exact tool names returned by the MCP gateway rather than guessing their host prefixes.

## 4. Report

Return a concise result:

```text
Skill: PASS
MCP connection: PASS
Echo: PASS
Add (20 + 22 = 42): PASS
```

For any failure, replace PASS with FAIL and include the exact error.
