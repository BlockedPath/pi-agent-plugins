/** Runtime compatibility checks shared by discovery and adapter projection. */

import { resolveCommand, resolveCwd, type PluginVariables } from "./paths.ts";
import type { PluginMcpServer } from "./types.ts";

/** Expressions that pi-mcp-adapter would expand using its host environment. */
const ADAPTER_INTERPOLATION = /\$\{\w+\}|\$env:\w+|\{env:\w+\}/;

export interface ResolvedStdioServer {
	kind: "stdio";
	command: string;
	cwd: string;
}

export interface ResolvedHttpServer {
	kind: "streamable-http";
	url: string;
}

export type ResolvedRuntimeServer = ResolvedStdioServer | ResolvedHttpServer;

export type RuntimeResolution =
	| { value: ResolvedRuntimeServer; problem?: never }
	| { value?: never; problem: string };

/**
 * Resolve semantic paths and enforce the transports this integration can honor
 * literally. This runs during discovery and again before projection as defense
 * in depth.
 */
export function resolveRuntimeServer(
	config: PluginMcpServer,
	vars: PluginVariables,
): RuntimeResolution {
	if (config.type === "stdio") {
		const command = resolveCommand(vars.PLUGIN_ROOT, config.command);
		if (!command) {
			return {
				problem: `command "${config.command}" is not a bare name or a contained ./ path`,
			};
		}
		const cwd =
			config.cwd === undefined
				? vars.PLUGIN_ROOT
				: resolveCwd(config.cwd, vars);
		if (!cwd) {
			return {
				problem: `cwd "${config.cwd}" is not a permitted or contained form`,
			};
		}
		return { value: { kind: "stdio", command: command.command, cwd } };
	}

	if (config.type === "sse") {
		return {
			problem:
				"legacy SSE transport is unsupported because the runtime cannot select it for the initial connection",
		};
	}
	if (config.headers && Object.keys(config.headers).length > 0) {
		return {
			problem:
				"configured HTTP headers are unsupported because cross-origin redirect isolation cannot be enforced",
		};
	}
	if (ADAPTER_INTERPOLATION.test(config.url)) {
		return {
			problem:
				"URL contains environment-expression syntax that the MCP runtime cannot preserve literally",
		};
	}
	return { value: { kind: "streamable-http", url: config.url } };
}
