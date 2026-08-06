/** Agent Plugins 1.0.0 client extension for Pi. */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { registerPluginCommand } from "../src/plugin-command.ts";
import { PluginRuntime } from "../src/runtime.ts";

export default function agentPlugins(pi: ExtensionAPI): void {
	const runtime = new PluginRuntime();

	// Factory-time user sync lands before pi-mcp-adapter's session initialization.
	// A malformed plugin must never prevent Pi itself from starting.
	try {
		runtime.initializeUser();
	} catch {
		// session_start rescans and reports diagnostics with UI context.
	}

	pi.on("resources_discover", (event) => runtime.discoverResources(event.cwd));

	pi.on("session_start", async (_event, ctx) => {
		runtime.startSession(ctx.cwd, ctx.isProjectTrusted());
		const errors = runtime
			.allDiagnostics()
			.filter((diagnostic) => diagnostic.severity === "error");
		if (errors.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`Agent Plugins: ${errors.length} problem(s). Run /plugin list for detail.`,
				"warning",
			);
		}
		await promptForTrust(runtime, ctx);
	});

	registerPluginCommand(pi, runtime);

	pi.registerEntryRenderer("agent-plugins-report", (entry, _options, theme) => {
		const data = entry.data as { text: string };
		return new Text(theme.fg("dim", data.text));
	});
}

async function promptForTrust(
	runtime: PluginRuntime,
	ctx: ExtensionContext,
): Promise<void> {
	if (!ctx.hasUI) return;
	const pending = runtime.pendingTrust();
	if (pending.length === 0) return;

	const approved: string[] = [];
	for (const plugin of pending) {
		const servers = plugin.mcpServers.map((server) => server.name).join(", ");
		const accepted = await ctx.ui.confirm(
			`Trust plugin "${plugin.manifest.name}"?`,
			`It declares MCP server(s): ${servers}. Trusting lets them run with your permissions.`,
		);
		if (accepted) approved.push(plugin.manifest.name);
	}
	if (approved.length === 0) return;

	const { changed } = runtime.trustMany(approved);
	if (changed) {
		ctx.ui.notify(
			"Agent Plugins: MCP servers configured. Run /plugin reload to connect them.",
			"info",
		);
	}
}
