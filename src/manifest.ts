/**
 * Manifest loading and validation (§5).
 *
 * The manifest schema is *closed*, but §5.2 carves out two non-fatal
 * exceptions: an unknown top-level field, and a non-object `extensions`. Both
 * are reported and ignored. Every other schema violation rejects the plugin
 * outright, so this module returns a value only when the plugin is loadable.
 */

import { readJsonFile } from "./read-json.ts";
import {
	AUTHOR_FIELDS,
	error,
	MANIFEST_FIELDS,
	PI_NAMESPACE,
	PLUGIN_SCHEMA_ID,
	type Diagnostic,
	type PluginAuthor,
	type PluginManifest,
	type ValidationResult,
	warning,
} from "./types.ts";

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

/**
 * §5.5 name constraints. Returned as a message so callers can report which
 * rule failed rather than a generic "invalid name".
 */
export function validatePluginName(name: unknown): string | undefined {
	if (typeof name !== "string") return "name must be a string";
	if (name.length === 0) return "name must not be empty";
	if (name.length > 64) return "name must be at most 64 characters";
	if (name.includes("--")) return "name must not contain consecutive hyphens";
	if (name.includes("..")) return "name must not contain consecutive periods";
	if (!NAME_PATTERN.test(name)) {
		return "name must use only lowercase letters, digits, hyphens, and periods, and must start and end with an alphanumeric character";
	}
	return undefined;
}

/**
 * §5.2: `$schema` selects locally supported validation rules. The client must
 * never fetch the schema, and must reject versions it does not recognize.
 */
function isSupportedPluginSchema(value: unknown): boolean {
	return value === PLUGIN_SCHEMA_ID;
}

function validateAuthor(value: unknown): {
	author?: PluginAuthor;
	problem?: string;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { problem: "author must be an object" };
	}
	const entries = Object.entries(value as Record<string, unknown>);
	for (const [key, entry] of entries) {
		if (!(AUTHOR_FIELDS as readonly string[]).includes(key)) {
			return { problem: `author contains unsupported field "${key}"` };
		}
		if (typeof entry !== "string") {
			return { problem: `author.${key} must be a string` };
		}
	}
	return { author: Object.fromEntries(entries) as PluginAuthor };
}

function unknownFieldDiagnostics(
	obj: Record<string, unknown>,
	path: string,
): Diagnostic[] {
	return Object.keys(obj).flatMap((key) =>
		(MANIFEST_FIELDS as readonly string[]).includes(key)
			? []
			: [warning("5.2", `ignoring unknown manifest field "${key}"`, { path })],
	);
}

function applyMetadata(
	obj: Record<string, unknown>,
	manifest: PluginManifest,
	path: string,
): Diagnostic | undefined {
	for (const key of [
		"version",
		"description",
		"homepage",
		"repository",
		"license",
	] as const) {
		if (obj[key] === undefined) continue;
		if (typeof obj[key] !== "string")
			return error("5.4", `${key} must be a string`, { path });
		manifest[key] = obj[key] as string;
	}
	if (obj.keywords !== undefined) {
		if (
			!Array.isArray(obj.keywords) ||
			obj.keywords.some((value) => typeof value !== "string")
		) {
			return error("5.4", "keywords must be an array of strings", { path });
		}
		manifest.keywords = obj.keywords as string[];
	}
	if (obj.author !== undefined) {
		const { author, problem } = validateAuthor(obj.author);
		if (!author) return error("5.4", problem ?? "author is invalid", { path });
		manifest.author = author;
	}
	return undefined;
}

function applyExtensions(
	value: unknown,
	manifest: PluginManifest,
	path: string,
): Diagnostic[] {
	if (value === undefined) return [];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return [warning("8.1", "ignoring non-object extensions field", { path })];
	}

	const diagnostics: Diagnostic[] = [];
	const namespaces: Record<string, Record<string, unknown>> = {};
	for (const [namespace, entry] of Object.entries(value)) {
		if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
			namespaces[namespace] = entry as Record<string, unknown>;
		} else if (namespace === PI_NAMESPACE) {
			diagnostics.push(
				warning(
					"8.1",
					`ignoring extensions["${namespace}"]: value must be an object`,
					{ path },
				),
			);
		}
	}
	manifest.extensions = namespaces;
	return diagnostics;
}

/** Validate a parsed manifest object. `path` is used only for diagnostics. */
export function validateManifest(
	raw: unknown,
	path: string,
): ValidationResult<PluginManifest> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			diagnostics: [
				error("5.2", "plugin.json must contain a top-level JSON object", {
					path,
				}),
			],
		};
	}
	const obj = raw as Record<string, unknown>;
	const diagnostics = unknownFieldDiagnostics(obj, path);

	if (!isSupportedPluginSchema(obj.$schema)) {
		const declared =
			typeof obj.$schema === "string" ? obj.$schema : "(missing)";
		return {
			diagnostics: [
				...diagnostics,
				error("5.2", `unsupported Agent Plugins manifest schema: ${declared}`, {
					path,
				}),
			],
		};
	}
	const nameProblem = validatePluginName(obj.name);
	if (nameProblem)
		return {
			diagnostics: [...diagnostics, error("5.5", nameProblem, { path })],
		};

	const manifest: PluginManifest = {
		$schema: PLUGIN_SCHEMA_ID,
		name: obj.name as string,
	};
	const metadataProblem = applyMetadata(obj, manifest, path);
	if (metadataProblem)
		return { diagnostics: [...diagnostics, metadataProblem] };
	diagnostics.push(...applyExtensions(obj.extensions, manifest, path));
	return { value: manifest, diagnostics };
}

/** Read and validate `plugin.json` from disk. */
export function loadManifest(path: string): ValidationResult<PluginManifest> {
	const loaded = readJsonFile(path);
	if ("value" in loaded) return validateManifest(loaded.value, path);
	const section = loaded.kind === "read" ? "5.1" : "5.2";
	const prefix =
		loaded.kind === "read"
			? "cannot read plugin.json"
			: "plugin.json is not valid JSON";
	return {
		diagnostics: [error(section, `${prefix}: ${loaded.message}`, { path })],
	};
}
