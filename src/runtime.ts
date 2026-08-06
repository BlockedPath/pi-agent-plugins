/** Runtime registry and host integration, separated from the Pi entry point. */

import { loadAll } from "./loader.ts";
import {
	prepareDataDirs,
	projectAll,
	syncAdapterConfig,
} from "./mcp-bridge.ts";
import { resolvePluginRelative } from "./paths.ts";
import {
	projectManagedLedgerPath,
	projectPiMcpConfigPath,
	projectPluginsDir,
	userPluginsDir,
} from "./paths-client.ts";
import { readState, setDisabled, setTrustedMany } from "./state.ts";
import type { Diagnostic, LoadedPlugin, PluginScope } from "./types.ts";

export interface Registry {
	plugins: LoadedPlugin[];
	diagnostics: Diagnostic[];
	trusted: Set<string>;
}

export interface ResourcePaths {
	skillPaths: string[];
	promptPaths: string[];
	themePaths: string[];
}

export interface RuntimeSyncResult {
	changed: boolean;
	diagnostics: Diagnostic[];
}

/** Stable trust identity for one installed plugin instance. */
export function pluginTrustKey(plugin: LoadedPlugin): string {
	return plugin.scope === "user"
		? `user:${plugin.manifest.name}`
		: `project:${plugin.root}:${plugin.manifest.name}`;
}

function isStoredTrusted(
	plugin: LoadedPlugin,
	stored: ReadonlySet<string>,
): boolean {
	if (stored.has(pluginTrustKey(plugin))) return true;
	// Migrate the original name-only state for user plugins only. Never apply a
	// legacy user trust decision to a project plugin with the same manifest name.
	return plugin.scope === "user" && stored.has(plugin.manifest.name);
}

export class PluginRuntime {
	registry: Registry = { plugins: [], diagnostics: [], trusted: new Set() };
	activeCwd = process.cwd();
	activeProjectTrusted = false;

	initializeUser(): void {
		this.scan(process.cwd(), false);
		this.sync(false);
	}

	startSession(cwd: string, projectTrusted: boolean): RuntimeSyncResult {
		this.activeCwd = cwd;
		this.activeProjectTrusted = projectTrusted;
		this.scan(cwd, projectTrusted);
		return this.sync(projectTrusted);
	}

	scan(
		cwd = this.activeCwd,
		projectTrusted = this.activeProjectTrusted,
	): Registry {
		const state = readState();
		const roots: Array<{ dir: string; scope: PluginScope }> = [
			{ dir: userPluginsDir(), scope: "user" },
		];
		if (projectTrusted)
			roots.push({ dir: projectPluginsDir(cwd), scope: "project" });

		const report = loadAll(roots, new Set(state.disabled));
		const storedTrust = new Set(state.trusted);
		const trusted = new Set(
			report.plugins.flatMap((plugin) =>
				isStoredTrusted(plugin, storedTrust) ? [plugin.manifest.name] : [],
			),
		);
		this.registry = {
			plugins: report.plugins,
			diagnostics: report.diagnostics,
			trusted,
		};
		return this.registry;
	}

	find(name: string): LoadedPlugin | undefined {
		return this.registry.plugins.find(
			(plugin) => plugin.manifest.name === name,
		);
	}

	setEnabled(name: string, enabled: boolean): RuntimeSyncResult {
		setDisabled(name, !enabled);
		this.scan();
		return this.sync();
	}

	trust(name: string): RuntimeSyncResult {
		return this.trustMany([name]);
	}

	trustMany(names: readonly string[]): RuntimeSyncResult {
		const plugins = names.flatMap((name) => {
			const plugin = this.find(name);
			return plugin ? [plugin] : [];
		});
		setTrustedMany(plugins.map(pluginTrustKey));
		for (const plugin of plugins)
			this.registry.trusted.add(plugin.manifest.name);
		return this.sync();
	}

	pendingTrust(): LoadedPlugin[] {
		return this.registry.plugins.filter(
			(plugin) =>
				plugin.enabled &&
				plugin.mcpServers.length > 0 &&
				!this.registry.trusted.has(plugin.manifest.name),
		);
	}

	allDiagnostics(): Diagnostic[] {
		return [
			...this.registry.diagnostics,
			...this.registry.plugins.flatMap((plugin) => plugin.diagnostics),
		];
	}

	discoverResources(cwd: string): ResourcePaths {
		const projectTrusted = this.activeProjectTrusted && this.activeCwd === cwd;
		this.scan(cwd, projectTrusted);

		const enabled = this.registry.plugins.filter((plugin) => plugin.enabled);
		const skillPaths = enabled.flatMap((plugin) =>
			plugin.skills.map((skill) => skill.skillFile),
		);
		const promptPaths = enabled.flatMap((plugin) =>
			this.extensionPaths(plugin, "prompts"),
		);
		const themePaths = enabled.flatMap((plugin) =>
			this.extensionPaths(plugin, "themes"),
		);
		return { skillPaths, promptPaths, themePaths };
	}

	sync(includeProject = this.activeProjectTrusted): RuntimeSyncResult {
		const eligible = this.registry.plugins.filter(
			(plugin) =>
				plugin.enabled && this.registry.trusted.has(plugin.manifest.name),
		);
		const preparation = prepareDataDirs(eligible);
		const diagnostics = [...preparation.diagnostics];

		const userProjection = projectAll(
			preparation.plugins.filter((plugin) => plugin.scope === "user"),
		);
		const userResult = syncAdapterConfig(userProjection);
		diagnostics.push(...userResult.diagnostics);

		if (!includeProject) return { changed: userResult.changed, diagnostics };

		const projectProjection = projectAll(
			preparation.plugins.filter((plugin) => plugin.scope === "project"),
		);
		const projectResult = syncAdapterConfig(
			projectProjection,
			projectPiMcpConfigPath(this.activeCwd),
			projectManagedLedgerPath(this.activeCwd),
		);
		diagnostics.push(...projectResult.diagnostics);
		return {
			changed: userResult.changed || projectResult.changed,
			diagnostics,
		};
	}

	private extensionPaths(
		plugin: LoadedPlugin,
		key: "prompts" | "themes",
	): string[] {
		const value = plugin.piExtension?.[key];
		if (!Array.isArray(value)) return [];
		return value.flatMap((relative) => {
			if (typeof relative !== "string") return [];
			const resolved = resolvePluginRelative(plugin.root, relative);
			return resolved ? [resolved] : [];
		});
	}
}
