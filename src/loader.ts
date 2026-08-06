/**
 * Plugin loading: root -> manifest -> components, applying the failure
 * boundaries in §4.1 and §11.3.
 *
 * The ordering is normative. §5.1 requires the manifest to load and validate
 * before any component discovery or client-specific behaviour, so a rejected
 * manifest must never reach the skill or MCP paths.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { loadManifest } from "./manifest.ts";
import { loadMcpConfig } from "./mcp-config.ts";
import { resolveRuntimeServer } from "./mcp-runtime.ts";
import {
	isContainedResolved,
	resolveExisting,
	resolveInRoot,
} from "./paths.ts";
import { pluginDataDir } from "./paths-client.ts";
import { validateSkillFile } from "./skill.ts";
import {
	PI_NAMESPACE,
	error,
	info,
	type Diagnostic,
	type LoadedMcpServer,
	type LoadedPlugin,
	type LoadedSkill,
	type LoadReport,
	type PluginScope,
	warning,
} from "./types.ts";

export interface LoadOptions {
	scope: PluginScope;
	/** Names the user has disabled; still loaded and listed, but not activated. */
	disabled?: ReadonlySet<string>;
}

/**
 * Discover skills (§7.1).
 *
 * Only *immediate* child directories of `skills/` are considered, and each must
 * contain a `SKILL.md` that resolves to a regular file. Deeper descendants are
 * explicitly not searched, which is why this does not recurse.
 */
export function discoverSkills(root: string): {
	skills: LoadedSkill[];
	diagnostics: Diagnostic[];
} {
	const skillsDir = resolveInRoot(root, "skills");
	if (!skillsDir) {
		return {
			skills: [],
			diagnostics: [
				error("4.1", "skills resolves outside the plugin root", { path: root }),
			],
		};
	}
	if (!existsSync(skillsDir)) return { skills: [], diagnostics: [] };

	const listing = listSkillDirEntries(skillsDir);
	if (listing.diagnostic)
		return { skills: [], diagnostics: [listing.diagnostic] };

	const diagnostics: Diagnostic[] = [];
	const skills: LoadedSkill[] = [];

	for (const entry of listing.entries) {
		const skillFile = skillFileIn(join(skillsDir, entry));
		if (!skillFile) continue;

		// §4.1 boundary 3: a SKILL.md resolving outside the root skips that skill.
		if (!isContainedResolved(root, skillFile)) {
			diagnostics.push(
				warning(
					"4.1",
					"skipping skill: SKILL.md resolves outside the plugin root",
					{
						path: skillFile,
						component: entry,
					},
				),
			);
			continue;
		}

		const validation = validateSkillFile(skillFile);
		diagnostics.push(...validation.diagnostics);
		if (!validation.valid) continue;

		skills.push({ dir: entry, skillFile: resolveExisting(skillFile) });
	}

	return { skills, diagnostics };
}

/** Byte-order comparison, so listings do not vary with the host locale. */
function byCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

function listSkillDirEntries(skillsDir: string): {
	entries: string[];
	diagnostic?: Diagnostic;
} {
	// §6.2: present but wrong filesystem kind invalidates only this component type.
	try {
		if (!statSync(skillsDir).isDirectory()) {
			return {
				entries: [],
				diagnostic: error(
					"6.2",
					"skills is not a directory; skipping all skills",
					{ path: skillsDir },
				),
			};
		}
		return { entries: readdirSync(skillsDir).sort(byCodeUnit) };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			entries: [],
			diagnostic: error("6.2", `cannot read skills directory: ${message}`, {
				path: skillsDir,
			}),
		};
	}
}

/**
 * Return the `SKILL.md` inside an immediate child of `skills/`, or `undefined`
 * when the child is not a directory or holds no regular `SKILL.md`.
 */
function skillFileIn(dir: string): string | undefined {
	try {
		// statSync follows symlinks, so a symlinked skill directory is permitted
		// as long as the caller's containment check holds.
		if (!statSync(dir).isDirectory()) return undefined;
		const skillFile = join(dir, "SKILL.md");
		return statSync(skillFile).isFile() ? skillFile : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Namespace a plugin's MCP server so two plugins can each ship a server called
 * "github" without colliding in the host's flat server table.
 */
export function qualifyServerName(
	pluginName: string,
	serverName: string,
): string {
	const encode = (value: string): string => {
		let encoded = "";
		for (let index = 0; index < value.length; index += 1) {
			const codeUnit = value.charCodeAt(index);
			const safe =
				(codeUnit >= 0x61 && codeUnit <= 0x7a) ||
				(codeUnit >= 0x30 && codeUnit <= 0x39) ||
				codeUnit === 0x2d;
			encoded += safe
				? value[index]
				: `_${codeUnit.toString(16).padStart(4, "0")}`;
		}
		return encoded;
	};
	return `${encode(pluginName)}__${encode(serverName)}`;
}

/** Load one plugin from a directory containing `plugin.json`. */
export function loadPlugin(
	rootInput: string,
	options: LoadOptions,
): LoadedPlugin | { diagnostics: Diagnostic[] } {
	const root = resolveExisting(rootInput);
	const diagnostics: Diagnostic[] = [];

	const manifestPath = join(root, "plugin.json");
	if (!existsSync(manifestPath)) {
		return {
			diagnostics: [
				error("5.1", "no plugin.json in plugin root", { path: root }),
			],
		};
	}
	// §4.1 boundary 1: a manifest resolving outside the root rejects the plugin.
	if (!isContainedResolved(root, manifestPath)) {
		return {
			diagnostics: [
				error("4.1", "plugin.json resolves outside the plugin root", {
					path: manifestPath,
				}),
			],
		};
	}

	const manifestResult = loadManifest(manifestPath);
	diagnostics.push(...manifestResult.diagnostics);
	if (!manifestResult.value) return { diagnostics };
	const manifest = manifestResult.value;

	// The directory name is conventional, not normative; the manifest name wins.
	if (basename(root) !== manifest.name) {
		diagnostics.push(
			info(
				"5.5",
				`plugin directory "${basename(root)}" differs from manifest name "${manifest.name}"`,
				{
					path: root,
				},
			),
		);
	}

	const { skills, diagnostics: skillDiagnostics } = discoverSkills(root);
	diagnostics.push(...skillDiagnostics);

	const dataDir = pluginDataDir(manifest.name, options.scope, root);
	const mcpPath = resolveInRoot(root, "mcp.json");
	const mcpServers: LoadedMcpServer[] = [];
	if (mcpPath) {
		const mcpResult = loadMcpConfig(mcpPath, manifest.$schema);
		diagnostics.push(...mcpResult.diagnostics);
		for (const [name, config] of Object.entries(
			mcpResult.value?.mcpServers ?? {},
		)) {
			const resolution = resolveRuntimeServer(config, {
				PLUGIN_ROOT: root,
				PLUGIN_DATA: dataDir,
			});
			if (!resolution.value) {
				diagnostics.push(
					warning("7.2.2", `skipping MCP server: ${resolution.problem}`, {
						path: mcpPath,
						component: name,
					}),
				);
				continue;
			}
			mcpServers.push({
				name,
				qualifiedName: qualifyServerName(manifest.name, name),
				config,
			});
		}
	} else {
		diagnostics.push(
			error("4.1", "mcp.json resolves outside the plugin root", { path: root }),
		);
	}

	const plugin: LoadedPlugin = {
		manifest,
		root,
		dataDir,
		scope: options.scope,
		enabled: !options.disabled?.has(manifest.name),
		skills,
		mcpServers,
		diagnostics,
	};

	// §8.1: only this client's namespace is interpreted; others pass through untouched.
	const piExtension = manifest.extensions?.[PI_NAMESPACE];
	if (piExtension) plugin.piExtension = piExtension;

	return plugin;
}

/**
 * Scan an install root for plugins.
 *
 * Each immediate child directory containing `plugin.json` is one plugin. A
 * directory without a manifest is silently skipped rather than reported, since
 * install roots routinely hold unrelated scratch directories.
 */
function loadPluginsFrom(dir: string, options: LoadOptions): LoadReport {
	const plugins: LoadedPlugin[] = [];
	const diagnostics: Diagnostic[] = [];

	if (!existsSync(dir)) return { plugins, diagnostics };

	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			plugins,
			diagnostics: [
				warning("4.1", `cannot read plugins directory: ${message}`, {
					path: dir,
				}),
			],
		};
	}

	for (const entry of entries.sort(byCodeUnit)) {
		if (entry.startsWith(".")) continue;
		const root = join(dir, entry);
		try {
			if (!statSync(root).isDirectory()) continue;
		} catch {
			continue;
		}
		if (!existsSync(join(root, "plugin.json"))) continue;

		const result = loadPlugin(root, options);
		if ("manifest" in result) plugins.push(result);
		else diagnostics.push(...result.diagnostics);
	}

	return { plugins, diagnostics };
}

/**
 * Load every plugin root, deduplicating by manifest name.
 *
 * Project plugins are passed after user plugins and win on collision, matching
 * how pi resolves the same package configured at both scopes.
 */
export function loadAll(
	roots: Array<{ dir: string; scope: PluginScope }>,
	disabled: ReadonlySet<string>,
): LoadReport {
	const byName = new Map<string, LoadedPlugin>();
	const diagnostics: Diagnostic[] = [];

	for (const { dir, scope } of roots) {
		const report = loadPluginsFrom(dir, { scope, disabled });
		diagnostics.push(...report.diagnostics);
		for (const plugin of report.plugins) {
			const existing = byName.get(plugin.manifest.name);
			if (existing) {
				diagnostics.push(
					info(
						"11.3",
						`${plugin.scope} plugin "${plugin.manifest.name}" overrides the ${existing.scope} copy`,
						{
							path: plugin.root,
						},
					),
				);
			}
			byName.set(plugin.manifest.name, plugin);
		}
	}

	return { plugins: [...byName.values()], diagnostics };
}
