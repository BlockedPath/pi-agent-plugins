/**
 * Plain-text rendering of load results for the `/plugin` command.
 *
 * Kept free of TUI imports so it stays unit-testable and usable in headless
 * mode, where `ctx.ui` is unavailable.
 */

import type { Diagnostic, LoadedPlugin } from "./types.ts";

const SEVERITY_MARK: Record<Diagnostic["severity"], string> = {
	error: "x",
	warning: "!",
	info: "-",
};

export function formatDiagnostic(diagnostic: Diagnostic): string {
	const mark = SEVERITY_MARK[diagnostic.severity];
	const where = diagnostic.component ? ` (${diagnostic.component})` : "";
	return `  ${mark} §${diagnostic.section} ${diagnostic.message}${where}`;
}

function statusOf(plugin: LoadedPlugin, trusted: ReadonlySet<string>): string {
	if (!plugin.enabled) return "disabled";
	const hasErrors = plugin.diagnostics.some((d) => d.severity === "error");
	if (hasErrors) return "degraded";
	if (plugin.mcpServers.length > 0 && !trusted.has(plugin.manifest.name))
		return "untrusted";
	return "enabled";
}

function formatPluginLine(
	plugin: LoadedPlugin,
	trusted: ReadonlySet<string>,
): string {
	const { name, version } = plugin.manifest;
	const parts = [
		`${name}${version ? `@${version}` : ""}`,
		`[${statusOf(plugin, trusted)}]`,
	];
	const components: string[] = [];
	if (plugin.skills.length > 0)
		components.push(
			`${plugin.skills.length} skill${plugin.skills.length === 1 ? "" : "s"}`,
		);
	if (plugin.mcpServers.length > 0) {
		components.push(
			`${plugin.mcpServers.length} MCP server${plugin.mcpServers.length === 1 ? "" : "s"}`,
		);
	}
	parts.push(components.length > 0 ? components.join(", ") : "no components");
	parts.push(`(${plugin.scope})`);
	return parts.join("  ");
}

export function formatList(
	plugins: readonly LoadedPlugin[],
	trusted: ReadonlySet<string>,
): string {
	if (plugins.length === 0) {
		return "No Agent Plugins installed. Use /plugin install <source> to add one.";
	}
	const lines = [`Agent Plugins (${plugins.length}):`, ""];
	for (const plugin of plugins) {
		lines.push(formatPluginLine(plugin, trusted));
		const problems = plugin.diagnostics.filter((d) => d.severity !== "info");
		for (const diagnostic of problems) lines.push(formatDiagnostic(diagnostic));
	}
	return lines.join("\n");
}

function describeServer(server: LoadedPlugin["mcpServers"][number]): string {
	const { config } = server;
	if (config.type !== "stdio") return `${config.type}: ${config.url}`;
	const args = config.args?.length ? ` ${config.args.join(" ")}` : "";
	return `stdio: ${config.command}${args}`;
}

function metadataLines(plugin: LoadedPlugin): string[] {
	const { manifest } = plugin;
	const lines = [
		`root:      ${plugin.root}`,
		`data:      ${plugin.dataDir}`,
		`scope:     ${plugin.scope}`,
	];
	if (manifest.author?.name) lines.push(`author:    ${manifest.author.name}`);
	if (manifest.license) lines.push(`license:   ${manifest.license}`);
	if (manifest.homepage) lines.push(`homepage:  ${manifest.homepage}`);
	if (manifest.repository) lines.push(`repo:      ${manifest.repository}`);
	if (manifest.keywords?.length)
		lines.push(`keywords:  ${manifest.keywords.join(", ")}`);
	return lines;
}

function componentLines(plugin: LoadedPlugin): string[] {
	const lines: string[] = [];
	if (plugin.skills.length > 0) {
		lines.push("", "skills:");
		for (const skill of plugin.skills)
			lines.push(`  ${skill.dir}  ->  ${skill.skillFile}`);
	}
	if (plugin.mcpServers.length > 0) {
		lines.push("", "mcp servers:");
		for (const server of plugin.mcpServers) {
			lines.push(
				`  ${server.name}  (${server.qualifiedName})`,
				`    ${describeServer(server)}`,
			);
		}
	}
	return lines;
}

export function formatInfo(
	plugin: LoadedPlugin,
	trusted: ReadonlySet<string>,
): string {
	const { manifest } = plugin;
	const lines = [
		`${manifest.name}${manifest.version ? `@${manifest.version}` : ""}  [${statusOf(plugin, trusted)}]`,
		"",
	];
	if (manifest.description) lines.push(manifest.description, "");

	lines.push(...metadataLines(plugin), ...componentLines(plugin));

	// Namespaces other than this client's are shown but never interpreted (§8.1).
	const namespaces = Object.keys(manifest.extensions ?? {});
	if (namespaces.length > 0)
		lines.push("", `extensions: ${namespaces.join(", ")}`);

	if (plugin.diagnostics.length > 0) {
		lines.push("", "diagnostics:");
		for (const diagnostic of plugin.diagnostics)
			lines.push(formatDiagnostic(diagnostic));
	}

	return lines.join("\n");
}
