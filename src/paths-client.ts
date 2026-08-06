/**
 * Client-owned locations. Nothing here is specified by Agent Plugins — §4 and
 * §9.1 leave install roots and the PLUGIN_DATA location entirely to the client.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { PluginScope } from "./types.ts";

/** `~/.pi/agent`, honouring pi's own override. */
function agentDir(): string {
	const override = process.env.PI_AGENT_DIR;
	return override && override.length > 0
		? resolve(override)
		: join(homedir(), ".pi", "agent");
}

/** Global plugin install root: `~/.pi/agent/plugins`. */
export function userPluginsDir(): string {
	return join(agentDir(), "plugins");
}

/** Project plugin root: `<cwd>/.pi/plugins`. Loaded only when the project is trusted. */
export function projectPluginsDir(cwd: string): string {
	return join(cwd, ".pi", "plugins");
}

/**
 * Persistent per-plugin data directory (§9.1).
 *
 * Deliberately a sibling of the install root rather than a child of the plugin
 * itself: the spec requires it to survive plugin updates, which replace package
 * contents.
 */
export function pluginDataDir(
	pluginName: string,
	scope: PluginScope,
	pluginRoot: string,
): string {
	// Keep the original user path for backwards compatibility. Project plugins
	// are separate installed instances even when they deliberately reuse a user
	// plugin's manifest name, so key them by their resolved install root.
	if (scope === "user") return join(agentDir(), "plugin-data", pluginName);
	const instance = createHash("sha256")
		.update(resolve(pluginRoot))
		.digest("hex")
		.slice(0, 12);
	return join(
		agentDir(),
		"plugin-data",
		"project",
		`${pluginName}-${instance}`,
	);
}

/** Where this client records user-scoped MCP servers projected into pi-mcp-adapter. */
export function managedLedgerPath(): string {
	return join(agentDir(), "agent-plugins", "managed-mcp.json");
}

/** Project-scoped projection ledger, isolated to the current repository. */
export function projectManagedLedgerPath(cwd: string): string {
	return join(cwd, ".pi", "agent-plugins-managed-mcp.json");
}

/** Where enable/disable state lives. */
export function statePath(): string {
	return join(agentDir(), "agent-plugins", "state.json");
}

/** pi-mcp-adapter's Pi-global MCP config, the file this client projects into. */
export function piMcpConfigPath(): string {
	return join(agentDir(), "mcp.json");
}

/** pi-mcp-adapter's project-local MCP config. */
export function projectPiMcpConfigPath(cwd: string): string {
	return join(cwd, ".pi", "mcp.json");
}
