/**
 * Projection of Agent Plugins MCP servers into pi-mcp-adapter.
 *
 * Pi has no built-in MCP runtime; pi-mcp-adapter supplies one and reads its
 * servers from `~/.pi/agent/mcp.json`. Rather than duplicating a second MCP
 * client inside this extension, plugin-declared servers are translated into
 * that file so they inherit the adapter's OAuth, approval, tracing, and
 * lifecycle handling.
 *
 * The file belongs to the user, so this module only ever touches keys recorded
 * in its own ledger. Anything the user wrote by hand is preserved byte-for-byte
 * except where a key collides with a managed name.
 */

import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	resolveRuntimeServer,
	type ResolvedHttpServer,
	type ResolvedStdioServer,
} from "./mcp-runtime.ts";
import { expand, type PluginVariables } from "./paths.ts";
import { managedLedgerPath, piMcpConfigPath } from "./paths-client.ts";
import {
	type Diagnostic,
	type LoadedPlugin,
	type StdioServer,
	error,
	info,
	warning,
} from "./types.ts";

const STDIO_LAUNCHER = fileURLToPath(
	new URL("../bin/stdio-launcher.mjs", import.meta.url),
);

/** Subset of pi-mcp-adapter's ServerEntry that this bridge writes. */
interface AdapterServerEntry {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
}

export interface Projection {
	servers: Record<string, AdapterServerEntry>;
	diagnostics: Diagnostic[];
}

/**
 * Translate one plugin's servers into adapter entries.
 *
 * Every §7.2.1 runtime rule is enforced here rather than deferred to the
 * adapter, because the adapter's own config format is more permissive than the
 * portable one (it allows shell-ish commands, arbitrary cwd, and its own auth
 * fields). Enforcing before projection is what keeps this client conformant.
 */
export function projectPlugin(plugin: LoadedPlugin): Projection {
	const diagnostics: Diagnostic[] = [];
	const servers: Record<string, AdapterServerEntry> = Object.create(null);

	const vars: PluginVariables = {
		PLUGIN_ROOT: plugin.root,
		PLUGIN_DATA: plugin.dataDir,
	};

	for (const { config, name, qualifiedName } of plugin.mcpServers) {
		const component = `${plugin.manifest.name}/${name}`;
		const resolution = resolveRuntimeServer(config, vars);
		if (!resolution.value) {
			diagnostics.push(
				warning("7.2.2", `skipping server: ${resolution.problem}`, {
					component,
				}),
			);
			continue;
		}
		const entry =
			resolution.value.kind === "stdio"
				? projectStdio(config as StdioServer, resolution.value, vars)
				: projectHttp(resolution.value);
		if (Object.hasOwn(servers, qualifiedName)) {
			diagnostics.push(
				warning(
					"11.3",
					`skipping duplicate MCP server name "${qualifiedName}"`,
					{
						component,
					},
				),
			);
			continue;
		}
		servers[qualifiedName] = entry;
	}

	return { servers, diagnostics };
}

function projectHttp(config: ResolvedHttpServer): AdapterServerEntry {
	return { url: config.url };
}

function projectStdio(
	config: StdioServer,
	resolved: ResolvedStdioServer,
	vars: PluginVariables,
): AdapterServerEntry {
	const env = Object.fromEntries(
		Object.entries(config.env ?? {}).map(([key, value]) => [
			key,
			expand(value, vars),
		]),
	);
	const payload = {
		command: resolved.command,
		args: (config.args ?? []).map((arg) => expand(arg, vars)),
		env,
		cwd: resolved.cwd,
		pluginRoot: vars.PLUGIN_ROOT,
		pluginData: vars.PLUGIN_DATA,
	};
	return {
		command: process.execPath,
		args: [
			STDIO_LAUNCHER,
			Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
		],
	};
}

/** Project every enabled plugin, reporting cross-plugin name collisions. */
export function projectAll(plugins: readonly LoadedPlugin[]): Projection {
	const servers: Record<string, AdapterServerEntry> = Object.create(null);
	const diagnostics: Diagnostic[] = [];

	for (const plugin of plugins) {
		if (!plugin.enabled) continue;
		const projection = projectPlugin(plugin);
		diagnostics.push(...projection.diagnostics);
		for (const [name, entry] of Object.entries(projection.servers)) {
			if (Object.hasOwn(servers, name)) {
				diagnostics.push(
					warning("11.3", `skipping duplicate MCP server name "${name}"`, {
						component: plugin.manifest.name,
					}),
				);
				continue;
			}
			servers[name] = entry;
		}
	}

	return { servers, diagnostics };
}

export interface DataDirPreparation {
	plugins: LoadedPlugin[];
	diagnostics: Diagnostic[];
}

/**
 * Prepare writable PLUGIN_DATA before stdio launch (§9.1). If preparation
 * fails, only that plugin's stdio entries are removed; independently valid
 * HTTP entries remain loadable under §11.3's narrow failure boundary.
 */
export function prepareDataDirs(
	plugins: readonly LoadedPlugin[],
): DataDirPreparation {
	const prepared: LoadedPlugin[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const plugin of plugins) {
		const hasStdio = plugin.mcpServers.some(
			(server) => server.config.type === "stdio",
		);
		if (!hasStdio) {
			prepared.push(plugin);
			continue;
		}
		try {
			mkdirSync(plugin.dataDir, { recursive: true });
			accessSync(plugin.dataDir, constants.W_OK);
			prepared.push(plugin);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			diagnostics.push(
				error(
					"9.1",
					`skipping stdio servers: PLUGIN_DATA is not writable: ${message}`,
					{
						path: plugin.dataDir,
						component: plugin.manifest.name,
					},
				),
			);
			prepared.push({
				...plugin,
				mcpServers: plugin.mcpServers.filter(
					(server) => server.config.type !== "stdio",
				),
			});
		}
	}
	return { plugins: prepared, diagnostics };
}

interface Ledger {
	/** Server keys this client wrote on its last sync. */
	managed: string[];
}

function readLedger(path: string): Ledger {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			Array.isArray((parsed as Ledger).managed)
		) {
			return {
				managed: (parsed as Ledger).managed.filter(
					(key) => typeof key === "string",
				),
			};
		}
	} catch {
		// A missing or corrupt ledger means "nothing is managed yet"; the sync
		// below simply re-adds current keys without pruning unknown ones.
	}
	return { managed: [] };
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

export interface SyncResult {
	added: string[];
	removed: string[];
	changed: boolean;
	diagnostics: Diagnostic[];
}

function readAdapterConfig(path: string): {
	config?: Record<string, unknown>;
	diagnostic?: Diagnostic;
} {
	if (!existsSync(path)) return { config: {} };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error("top-level value is not an object");
		}
		return { config: parsed as Record<string, unknown> };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			diagnostic: error(
				"7.2.2",
				`refusing to overwrite unreadable MCP configuration: ${message}`,
				{ path },
			),
		};
	}
}

interface ReconcileResult {
	existing: Record<string, unknown>;
	accepted: string[];
	added: string[];
	removed: string[];
	diagnostics: Diagnostic[];
}

function reconcileServers(
	projection: Projection,
	config: Record<string, unknown>,
	ledger: Ledger,
	configPath: string,
): ReconcileResult {
	const existing =
		typeof config.mcpServers === "object" &&
		config.mcpServers !== null &&
		!Array.isArray(config.mcpServers)
			? { ...(config.mcpServers as Record<string, unknown>) }
			: {};
	const removed: string[] = [];
	for (const key of ledger.managed) {
		if (key in projection.servers || !(key in existing)) continue;
		delete existing[key];
		removed.push(key);
	}

	const accepted: string[] = [];
	const added: string[] = [];
	const diagnostics: Diagnostic[] = [];
	for (const [key, entry] of Object.entries(projection.servers)) {
		const prior = existing[key];
		if (prior !== undefined && !ledger.managed.includes(key)) {
			diagnostics.push(
				warning(
					"11.3",
					`not overwriting existing MCP server "${key}" defined outside Agent Plugins`,
					{
						path: configPath,
						component: key,
					},
				),
			);
			continue;
		}
		if (JSON.stringify(prior) !== JSON.stringify(entry)) added.push(key);
		existing[key] = entry;
		accepted.push(key);
	}
	return { existing, accepted, added, removed, diagnostics };
}

function persistReconciliation(
	config: Record<string, unknown>,
	reconciled: ReconcileResult,
	configPath: string,
	ledgerPath: string,
): Diagnostic | undefined {
	try {
		config.mcpServers = reconciled.existing;
		writeJsonAtomic(configPath, config);
		writeJsonAtomic(ledgerPath, {
			managed: reconciled.accepted,
		} satisfies Ledger);
		return undefined;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return error("7.2.2", `cannot update MCP configuration: ${message}`, {
			path: configPath,
		});
	}
}

/** Reconcile projected servers while preserving every user-authored entry. */
export function syncAdapterConfig(
	projection: Projection,
	configPath = piMcpConfigPath(),
	ledgerPath = managedLedgerPath(),
): SyncResult {
	const diagnostics: Diagnostic[] = [...projection.diagnostics];
	const loaded = readAdapterConfig(configPath);
	if (!loaded.config) {
		if (loaded.diagnostic) diagnostics.push(loaded.diagnostic);
		return { added: [], removed: [], changed: false, diagnostics };
	}

	const reconciled = reconcileServers(
		projection,
		loaded.config,
		readLedger(ledgerPath),
		configPath,
	);
	diagnostics.push(...reconciled.diagnostics);
	const changed = reconciled.added.length > 0 || reconciled.removed.length > 0;
	if (!changed) return { added: [], removed: [], changed: false, diagnostics };

	const writeProblem = persistReconciliation(
		loaded.config,
		reconciled,
		configPath,
		ledgerPath,
	);
	if (writeProblem) {
		diagnostics.push(writeProblem);
		return {
			added: reconciled.added,
			removed: reconciled.removed,
			changed: false,
			diagnostics,
		};
	}
	diagnostics.push(
		info(
			"7.2.2",
			`MCP configuration updated (${reconciled.added.length} added, ${reconciled.removed.length} removed)`,
			{ path: configPath },
		),
	);
	return {
		added: reconciled.added,
		removed: reconciled.removed,
		changed: true,
		diagnostics,
	};
}
