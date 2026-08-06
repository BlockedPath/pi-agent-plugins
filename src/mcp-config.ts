/**
 * MCP configuration loading and validation (§7.2).
 *
 * Two nested failure boundaries apply here and the difference matters:
 *   - A top-level problem (bad JSON, wrong `$schema`, version mismatch with
 *     plugin.json, unknown top-level field) disables MCP for the whole plugin.
 *   - A bad individual server entry skips only that entry.
 * Neither ever affects skills.
 */

import { existsSync, statSync } from "node:fs";

import { readJsonFile } from "./read-json.ts";
import {
	HTTP_FIELDS,
	MCP_SCHEMA_ID,
	RESERVED_ENV,
	STDIO_FIELDS,
	error,
	type Diagnostic,
	type PluginMcpConfig,
	type PluginMcpServer,
	type ValidationResult,
	warning,
} from "./types.ts";

const MCP_TOP_LEVEL_FIELDS = ["$schema", "mcpServers"] as const;

/** RFC 7230 token, used for header field names. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Visible ASCII plus space/tab; no CR, LF, or NUL (header field values). */
const HEADER_VALUE_PATTERN = /^[\t\x20-\x7e\x80-\xff]*$/;

function isSupportedMcpSchema(value: unknown): boolean {
	return value === MCP_SCHEMA_ID;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** §7.2.1: non-loopback endpoints must use HTTPS; loopback may use HTTP. */
function isLoopbackHost(hostname: string): boolean {
	// URL parsing brackets IPv6 literals; strip them before comparing.
	const host =
		hostname.startsWith("[") && hostname.endsWith("]")
			? hostname.slice(1, -1)
			: hostname;
	if (host === "localhost") return true;
	if (host === "::1") return true;
	if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
		return host.split(".").every((part) => Number(part) <= 255);
	}
	return false;
}

function validateUrl(value: unknown): { url?: string; problem?: string } {
	if (typeof value !== "string") return { problem: "url must be a string" };

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { problem: "url must be an absolute URL" };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { problem: "url must use the http or https scheme" };
	}
	if (parsed.username !== "" || parsed.password !== "") {
		return { problem: "url must not contain user information" };
	}
	// `URL.hash` is empty for both "no fragment" and a bare trailing "#", so
	// check the raw string to reject the latter too.
	if (parsed.hash !== "" || value.includes("#")) {
		return { problem: "url must not contain a fragment" };
	}
	if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
		return { problem: "url must use https for non-loopback hosts" };
	}
	return { url: value };
}

function validateHeaders(value: unknown): {
	headers?: Record<string, string>;
	problem?: string;
} {
	if (!isPlainObject(value)) return { problem: "headers must be an object" };

	const seen = new Set<string>();
	const headers: Record<string, string> = Object.create(null);
	for (const [name, entry] of Object.entries(value)) {
		if (!HEADER_NAME_PATTERN.test(name)) {
			return {
				problem: `header name "${name}" is not a valid HTTP header field name`,
			};
		}
		// §7.2.1: header names are case-insensitive, so duplicates that differ
		// only by casing make the entry invalid rather than silently collapsing.
		const lower = name.toLowerCase();
		if (seen.has(lower)) {
			return {
				problem: `header "${name}" is specified more than once under different casing`,
			};
		}
		seen.add(lower);

		if (typeof entry !== "string")
			return { problem: `header "${name}" must have a string value` };
		if (!HEADER_VALUE_PATTERN.test(entry)) {
			return {
				problem: `header "${name}" has an invalid HTTP header field value`,
			};
		}
		headers[name] = entry;
	}
	return { headers };
}

function unknownField(
	obj: Record<string, unknown>,
	allowed: readonly string[],
): string | undefined {
	return Object.keys(obj).find((key) => !allowed.includes(key));
}

type EntryResult = { server?: PluginMcpServer; problem?: string };

function validateStdioEntry(raw: Record<string, unknown>): EntryResult {
	const extra = unknownField(raw, STDIO_FIELDS);
	if (extra)
		return { problem: `stdio server contains unsupported field "${extra}"` };

	if (typeof raw.command !== "string" || raw.command.length === 0) {
		return { problem: "stdio server requires a non-empty string command" };
	}

	const server: PluginMcpServer = { type: "stdio", command: raw.command };

	if (raw.args !== undefined) {
		if (
			!Array.isArray(raw.args) ||
			raw.args.some((a) => typeof a !== "string")
		) {
			return { problem: "args must be an array of strings" };
		}
		server.args = raw.args as string[];
	}

	if (raw.env !== undefined) {
		const problem = validateEnv(raw.env);
		if (problem) return { problem };
		server.env = raw.env as Record<string, string>;
	}

	if (raw.cwd !== undefined) {
		if (typeof raw.cwd !== "string") return { problem: "cwd must be a string" };
		server.cwd = raw.cwd;
	}

	return { server };
}

function validateEnv(value: unknown): string | undefined {
	if (!isPlainObject(value)) return "env must be an object";
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") return `env["${key}"] must be a string`;
		// §9.2: the client owns these names; a plugin that sets them is invalid.
		if ((RESERVED_ENV as readonly string[]).includes(key)) {
			return `env must not contain the client-reserved variable "${key}"`;
		}
	}
	return undefined;
}

function validateHttpEntry(
	raw: Record<string, unknown>,
	type: "streamable-http" | "sse",
): EntryResult {
	const extra = unknownField(raw, HTTP_FIELDS);
	if (extra)
		return { problem: `${type} server contains unsupported field "${extra}"` };

	const { url, problem } = validateUrl(raw.url);
	if (problem || !url) return { problem: problem ?? "url is invalid" };

	const server: PluginMcpServer = { type, url };

	if (raw.headers !== undefined) {
		const result = validateHeaders(raw.headers);
		if (result.problem || !result.headers)
			return { problem: result.problem ?? "headers are invalid" };
		server.headers = result.headers;
	}

	return { server };
}

/**
 * Validate one server entry against its closed variant (§7.2.1).
 * Returns a problem message instead of throwing; callers skip only this entry.
 */
export function validateServerEntry(raw: unknown): EntryResult {
	if (!isPlainObject(raw))
		return { problem: "server configuration must be an object" };

	const type = raw.type;
	if (type === "stdio") return validateStdioEntry(raw);
	if (type === "streamable-http" || type === "sse")
		return validateHttpEntry(raw, type);

	const declared = typeof type === "string" ? `"${type}"` : "(missing)";
	return { problem: `unknown server type ${declared}` };
}

/**
 * Validate a parsed `mcp.json` document.
 *
 * `pluginSchemaId` is the `$schema` from `plugin.json`; §10.1 requires both
 * documents to target the same Agent Plugins version.
 */
export function validateMcpConfig(
	raw: unknown,
	path: string,
	pluginSchemaId: string,
): ValidationResult<PluginMcpConfig> {
	const diagnostics: Diagnostic[] = [];

	if (!isPlainObject(raw)) {
		diagnostics.push(
			error("7.2.1", "mcp.json must contain a top-level JSON object", { path }),
		);
		return { diagnostics };
	}

	if (!isSupportedMcpSchema(raw.$schema)) {
		const declared =
			typeof raw.$schema === "string" ? raw.$schema : "(missing)";
		diagnostics.push(
			error("7.2.2", `unsupported MCP configuration schema: ${declared}`, {
				path,
			}),
		);
		return { diagnostics };
	}

	// §10.1: mcp.json and plugin.json must declare the same spec version.
	const pluginVersion = versionOf(pluginSchemaId);
	const mcpVersion = versionOf(MCP_SCHEMA_ID);
	if (pluginVersion !== mcpVersion) {
		diagnostics.push(
			error(
				"10.1",
				`mcp.json targets ${mcpVersion} but plugin.json targets ${pluginVersion}`,
				{ path },
			),
		);
		return { diagnostics };
	}

	const extra = unknownField(raw, MCP_TOP_LEVEL_FIELDS);
	if (extra) {
		diagnostics.push(
			error(
				"7.2.1",
				`mcp.json contains unsupported top-level field "${extra}"`,
				{ path },
			),
		);
		return { diagnostics };
	}

	if (!isPlainObject(raw.mcpServers)) {
		diagnostics.push(
			error("7.2.1", "mcp.json requires an mcpServers object", { path }),
		);
		return { diagnostics };
	}

	// An empty mcpServers object is explicitly valid (§7.2.1).
	const mcpServers: Record<string, PluginMcpServer> = Object.create(null);
	for (const [name, entry] of Object.entries(raw.mcpServers)) {
		const { server, problem } = validateServerEntry(entry);
		if (!server) {
			// §7.2.2 rule 3: skip this entry, keep the siblings.
			diagnostics.push(
				warning("7.2.2", `skipping MCP server: ${problem}`, {
					path,
					component: name,
				}),
			);
			continue;
		}
		mcpServers[name] = server;
	}

	return { value: { $schema: MCP_SCHEMA_ID, mcpServers }, diagnostics };
}

function versionOf(schemaId: string): string {
	return schemaId.match(/\/schemas\/([^/]+)\//)?.[1] ?? "unknown";
}

/**
 * Load `mcp.json` from a plugin root.
 *
 * Returns `undefined` with no diagnostics when the file is absent, since §6.2
 * makes a missing fixed location a non-event.
 */
export function loadMcpConfig(
	path: string,
	pluginSchemaId: string,
): ValidationResult<PluginMcpConfig> {
	if (!existsSync(path)) return { diagnostics: [] };

	// §6.2: a fixed location of the wrong filesystem kind invalidates only that
	// component type.
	try {
		if (!statSync(path).isFile()) {
			return {
				diagnostics: [error("6.2", "mcp.json is not a regular file", { path })],
			};
		}
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			diagnostics: [error("6.2", `cannot stat mcp.json: ${message}`, { path })],
		};
	}

	const loaded = readJsonFile(path);
	if ("value" in loaded)
		return validateMcpConfig(loaded.value, path, pluginSchemaId);
	const prefix =
		loaded.kind === "read"
			? "cannot read mcp.json"
			: "mcp.json is not valid JSON";
	return {
		diagnostics: [error("7.2.2", `${prefix}: ${loaded.message}`, { path })],
	};
}
