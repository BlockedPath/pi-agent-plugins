/**
 * Path containment (§4.1) and placeholder expansion (§9.2).
 *
 * These two modules are the security-critical core of the client: everything
 * that turns plugin-authored strings into filesystem or process behaviour goes
 * through here.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * Resolve a path as far as it exists on disk, so that symlinked prefixes are
 * collapsed before a containment check. `realpathSync` throws for paths that do
 * not exist yet, so walk up to the nearest existing ancestor and re-append the
 * remainder. This matters because §4.1 requires containment of the
 * *filesystem-resolved* path, and a plugin can point at a not-yet-created file
 * inside a symlinked directory.
 */
export function resolveExisting(target: string): string {
	let current = resolve(target);
	const trailing: string[] = [];

	for (;;) {
		try {
			const real = realpathSync(current);
			return trailing.length === 0
				? real
				: resolve(real, ...trailing.toReversed());
		} catch {
			const parent = resolve(current, "..");
			if (parent === current) return resolve(target);
			trailing.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

/** True when `target` is `root` itself or lies beneath it. */
function isContained(root: string, target: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	if (normalizedTarget === normalizedRoot) return true;
	const prefix = normalizedRoot.endsWith(sep)
		? normalizedRoot
		: `${normalizedRoot}${sep}`;
	return normalizedTarget.startsWith(prefix);
}

/**
 * Containment check against the filesystem-resolved root, per §4.1.
 * Symlinks may resolve to targets *within* the root; anything escaping is denied.
 */
export function isContainedResolved(root: string, target: string): boolean {
	return isContained(resolveExisting(root), resolveExisting(target));
}

/**
 * §4.1(4): a configuration field defined as a plugin-relative path MUST begin
 * with `./`, resolve against the plugin root, and stay inside it.
 *
 * Returns the absolute path, or `undefined` when the value is not a conformant
 * plugin-relative path. Callers map `undefined` onto the narrowest applicable
 * failure boundary.
 */
export function resolvePluginRelative(
	root: string,
	value: string,
): string | undefined {
	if (!value.startsWith("./")) return undefined;
	// A leading `./` does not by itself prevent traversal: `./../x` is still an
	// escape, which is why the containment check below is not optional.
	const absolute = resolve(root, value.slice(2));
	if (!isContainedResolved(root, absolute)) return undefined;
	return absolute;
}

/** Join a package path onto the root and verify §4.1 containment. */
export function resolveInRoot(
	root: string,
	...segments: string[]
): string | undefined {
	const absolute = resolve(root, ...segments);
	if (!isContainedResolved(root, absolute)) return undefined;
	return absolute;
}

// ---------------------------------------------------------------------------
// Placeholder expansion (§9.2)
// ---------------------------------------------------------------------------

export interface PluginVariables {
	PLUGIN_ROOT: string;
	PLUGIN_DATA: string;
}

const PLACEHOLDER = /\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g;

/**
 * Single-pass, non-recursive replacement of `${PLUGIN_ROOT}` and
 * `${PLUGIN_DATA}` (§9.2). Text introduced by a replacement is never rescanned,
 * which `String.prototype.replace` with a function already guarantees.
 * Unrecognized placeholder-like text stays literal, and no other
 * environment-variable expansion is performed.
 */
export function expand(value: string, vars: PluginVariables): string {
	return value.replace(
		PLACEHOLDER,
		(_match, name: "PLUGIN_ROOT" | "PLUGIN_DATA") => vars[name],
	);
}

type CwdForm =
	| { kind: "plugin-relative" }
	| { kind: "plugin-root" }
	| { kind: "plugin-data" };

/** Classify a `cwd` value against the three permitted forms in §7.2.1. */
function classifyCwd(value: string): CwdForm | undefined {
	if (value.startsWith("./")) return { kind: "plugin-relative" };
	if (value === "${PLUGIN_ROOT}" || value.startsWith("${PLUGIN_ROOT}/"))
		return { kind: "plugin-root" };
	if (value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/"))
		return { kind: "plugin-data" };
	return undefined;
}

/**
 * Resolve a stdio server `cwd` (§7.2.1).
 *
 * Placeholders expand before resolution. Plugin-relative and `${PLUGIN_ROOT}`
 * forms must stay within the plugin root; `${PLUGIN_DATA}` forms must stay
 * within the plugin data directory. Anything else invalidates the server entry.
 */
export function resolveCwd(
	value: string,
	vars: PluginVariables,
): string | undefined {
	const form = classifyCwd(value);
	if (!form) return undefined;

	const expanded = expand(value, vars);
	const absolute =
		form.kind === "plugin-relative"
			? resolve(vars.PLUGIN_ROOT, value.slice(2))
			: expanded;
	if (!isAbsolute(absolute)) return undefined;

	const containmentRoot =
		form.kind === "plugin-data" ? vars.PLUGIN_DATA : vars.PLUGIN_ROOT;
	if (!isContainedResolved(containmentRoot, absolute)) return undefined;
	return absolute;
}

/**
 * Resolve a stdio `command` (§7.2.1).
 *
 * `command` is a single executable token, never a shell string, and never
 * placeholder-expanded. A bare name defers to the platform executable search;
 * a `./` path resolves against the plugin root under containment.
 */
export type ResolvedCommand =
	| { kind: "bare"; command: string }
	| { kind: "plugin-relative"; command: string };

export function resolveCommand(
	root: string,
	command: string,
): ResolvedCommand | undefined {
	if (command.length === 0) return undefined;
	if (command.startsWith("./")) {
		const absolute = resolvePluginRelative(root, command);
		if (!absolute) return undefined;
		return { kind: "plugin-relative", command: absolute };
	}
	// Reject anything that looks like a path but is not plugin-relative: an
	// absolute path, a parent traversal, or a nested relative path all fall
	// outside the two permitted forms.
	if (isAbsolute(command) || command.includes("/") || command.includes("\\"))
		return undefined;
	return { kind: "bare", command };
}
