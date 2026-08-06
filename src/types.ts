/**
 * Agent Plugins 1.0.0 types.
 *
 * Mirrors the normative structures in the specification:
 * https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */

export const PLUGIN_SCHEMA_ID =
	"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_ID =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** Reverse-domain extension namespace owned by this client (§8). */
export const PI_NAMESPACE = "dev.pi.agent";

/** Spec version this client implements. */
export const SUPPORTED_SPEC_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// Manifest (§5)
// ---------------------------------------------------------------------------

export interface PluginAuthor {
	name?: string;
	email?: string;
	url?: string;
}

export interface PluginManifest {
	$schema: string;
	name: string;
	version?: string;
	description?: string;
	author?: PluginAuthor;
	homepage?: string;
	repository?: string;
	license?: string;
	keywords?: string[];
	extensions?: Record<string, Record<string, unknown>>;
}

/** Closed set of permitted top-level manifest fields (§5.2). */
export const MANIFEST_FIELDS = [
	"$schema",
	"name",
	"version",
	"description",
	"author",
	"homepage",
	"repository",
	"license",
	"keywords",
	"extensions",
] as const;

/** Closed set of permitted author fields (§5.4). */
export const AUTHOR_FIELDS = ["name", "email", "url"] as const;

// ---------------------------------------------------------------------------
// MCP configuration (§7.2)
// ---------------------------------------------------------------------------

export interface StdioServer {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
}

interface HttpServer {
	type: "streamable-http" | "sse";
	url: string;
	headers?: Record<string, string>;
}

export type PluginMcpServer = StdioServer | HttpServer;

export interface PluginMcpConfig {
	$schema: string;
	mcpServers: Record<string, PluginMcpServer>;
}

export const STDIO_FIELDS = ["type", "command", "args", "env", "cwd"] as const;
export const HTTP_FIELDS = ["type", "url", "headers"] as const;

/** Environment variable names the client owns and plugins may not set (§9.2). */
export const RESERVED_ENV = ["PLUGIN_ROOT", "PLUGIN_DATA"] as const;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

type DiagnosticSeverity = "error" | "warning" | "info";

/**
 * A reportable condition. The spec repeatedly requires clients to *report*
 * invalid input while continuing to load independent components (§11.3),
 * so every rejection path produces one of these instead of throwing.
 */
export interface Diagnostic {
	severity: DiagnosticSeverity;
	/** Spec section this diagnostic derives from, e.g. "7.2.2". */
	section: string;
	message: string;
	/** Filesystem path the diagnostic concerns, when applicable. */
	path?: string;
	/** Component identity, e.g. a skill name or MCP server name. */
	component?: string;
}

export interface ValidationResult<T> {
	value?: T;
	diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// Loaded plugin
// ---------------------------------------------------------------------------

export type PluginScope = "user" | "project";

export interface LoadedSkill {
	/** Directory name under `skills/` (the immediate child directory). */
	dir: string;
	/** Absolute path to SKILL.md. */
	skillFile: string;
}

export interface LoadedMcpServer {
	/** Server name as declared in `mcp.json`. */
	name: string;
	/** Name this server is exposed under to avoid cross-plugin collisions. */
	qualifiedName: string;
	config: PluginMcpServer;
}

export interface LoadedPlugin {
	manifest: PluginManifest;
	/** Absolute, symlink-resolved plugin root. */
	root: string;
	/** Absolute path to this plugin's persistent PLUGIN_DATA directory. */
	dataDir: string;
	scope: PluginScope;
	enabled: boolean;
	skills: LoadedSkill[];
	mcpServers: LoadedMcpServer[];
	/** Contents of `extensions["dev.pi.agent"]`, when present. */
	piExtension?: Record<string, unknown>;
	diagnostics: Diagnostic[];
}

export interface LoadReport {
	plugins: LoadedPlugin[];
	/** Diagnostics not attributable to a successfully loaded plugin. */
	diagnostics: Diagnostic[];
}

export function error(
	section: string,
	message: string,
	extra: Partial<Diagnostic> = {},
): Diagnostic {
	return { severity: "error", section, message, ...extra };
}

export function warning(
	section: string,
	message: string,
	extra: Partial<Diagnostic> = {},
): Diagnostic {
	return { severity: "warning", section, message, ...extra };
}

export function info(
	section: string,
	message: string,
	extra: Partial<Diagnostic> = {},
): Diagnostic {
	return { severity: "info", section, message, ...extra };
}
