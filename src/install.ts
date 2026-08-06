/**
 * Plugin installation.
 *
 * Installation sources, registries, and update UX are explicitly outside the
 * Agent Plugins specification, so this is pure client policy. The one rule the
 * spec does impose is that a plugin is a directory rooted at a single
 * filesystem location containing `plugin.json` (§4.1), which is validated after
 * every fetch before the install is accepted.
 */

import { execFile } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { x as extractTar } from "tar";

import { loadManifest } from "./manifest.ts";
import { userPluginsDir } from "./paths-client.ts";
import type { PluginManifest } from "./types.ts";

const execFileAsync = promisify(execFile);

export type InstallSource =
	| { kind: "git"; url: string; ref?: string }
	| { kind: "npm"; spec: string }
	| { kind: "path"; path: string };

export interface InstallResult {
	manifest: PluginManifest;
	root: string;
	source: InstallSource;
}

/**
 * Parse an install specifier.
 *
 * Accepted: `npm:pkg@version`, `github.com/user/repo`, `https://…`,
 * `git@host:path`, `git:…`, an optional `@ref` suffix, and local paths.
 */
export function parseSource(spec: string): InstallSource | { error: string } {
	const trimmed = spec.trim();
	if (trimmed.length === 0) return { error: "empty plugin source" };
	if (trimmed.startsWith("npm:")) return parseNpmSource(trimmed);
	if (isLocalSource(trimmed))
		return { kind: "path", path: resolve(expandHome(trimmed)) };
	return parseGitSource(trimmed, spec);
}

function parseNpmSource(value: string): InstallSource | { error: string } {
	const spec = value.slice(4);
	if (spec.length === 0) return { error: "empty npm package specifier" };
	return { kind: "npm", spec };
}

function isLocalSource(value: string): boolean {
	return ["/", "./", "../", "~"].some((prefix) => value.startsWith(prefix));
}

function expandHome(value: string): string {
	return value.startsWith("~")
		? join(process.env.HOME ?? "", value.slice(1))
		: value;
}

function parseGitSource(
	value: string,
	original: string,
): InstallSource | { error: string } {
	const withoutPrefix = value.startsWith("git:") ? value.slice(4) : value;
	const lastSlash = withoutPrefix.lastIndexOf("/");
	const atIndex = withoutPrefix.indexOf("@", lastSlash + 1);
	const url = atIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, atIndex);
	const ref = atIndex === -1 ? undefined : withoutPrefix.slice(atIndex + 1);

	if (/^(https?|ssh|git):\/\//.test(url) || /^[^/]+@[^/]+:/.test(url)) {
		return gitSource(url, ref);
	}
	if (/^[\w.-]+\.[\w.-]+\/.+/.test(url))
		return gitSource(`https://${url}`, ref);
	return { error: `unrecognized plugin source: ${original}` };
}

function gitSource(url: string, ref: string | undefined): InstallSource {
	return ref ? { kind: "git", url, ref } : { kind: "git", url };
}

export interface InstallOptions {
	/** Install root; defaults to the user plugin directory. */
	targetDir?: string;
	/** Overwrite an existing install of the same name. */
	force?: boolean;
	signal?: AbortSignal;
}

/**
 * Fetch a plugin into a staging directory, validate it, then move it into place.
 *
 * Staging first means a plugin whose manifest is rejected never appears in the
 * install root, so a failed install cannot leave a half-loaded plugin behind.
 */
export async function install(
	source: InstallSource,
	options: InstallOptions = {},
): Promise<InstallResult> {
	const targetRoot = options.targetDir ?? userPluginsDir();
	const staging = mkdtempSync(join(tmpdir(), "pi-agent-plugin-"));

	try {
		const staged = join(staging, "plugin");
		if (source.kind === "git") {
			await cloneGit(source, staged, options.signal);
		} else if (source.kind === "npm") {
			await packNpm(source.spec, staging, staged, options.signal);
		} else {
			if (!existsSync(source.path) || !statSync(source.path).isDirectory()) {
				throw new Error(`not a directory: ${source.path}`);
			}
			cpSync(source.path, staged, { recursive: true, dereference: false });
		}

		// §4.1/§5.1: a plugin without a valid root manifest is not a plugin.
		const manifestPath = join(staged, "plugin.json");
		if (!existsSync(manifestPath)) {
			throw new Error(
				"source has no plugin.json at its root; not an Agent Plugin",
			);
		}
		const { value: manifest, diagnostics } = loadManifest(manifestPath);
		if (!manifest) {
			const reason =
				diagnostics.find((d) => d.severity === "error")?.message ??
				"invalid manifest";
			throw new Error(`invalid plugin.json: ${reason}`);
		}

		// Install under the manifest name so discovery and identity agree.
		const destination = join(targetRoot, manifest.name);
		if (existsSync(destination)) {
			if (!options.force)
				throw new Error(`plugin "${manifest.name}" is already installed`);
			rmSync(destination, { recursive: true, force: true });
		}

		mkdirSync(targetRoot, { recursive: true });
		// Copy rather than rename: staging is in the OS temp dir, which is
		// frequently a different filesystem from the agent directory.
		cpSync(staged, destination, { recursive: true, dereference: false });

		return { manifest, root: destination, source };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

async function cloneGit(
	source: Extract<InstallSource, { kind: "git" }>,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	const args = ["clone", "--depth", "1"];
	if (source.ref) args.push("--branch", source.ref);
	args.push("--", source.url, destination);

	try {
		await execFileAsync("git", args, {
			...(signal ? { signal } : {}),
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`git clone failed: ${message}`);
	}

	// A shallow clone keeps .git around; it is not part of the package and only
	// bloats the install root.
	rmSync(join(destination, ".git"), { recursive: true, force: true });
}

interface NpmPackResult {
	filename?: string;
}

function firstPackResult(value: unknown): NpmPackResult | undefined {
	if (Array.isArray(value)) return value[0] as NpmPackResult | undefined;
	if (typeof value === "object" && value !== null) {
		return Object.values(value)[0] as NpmPackResult | undefined;
	}
	return undefined;
}

/** Download an npm package without running package lifecycle scripts. */
async function packNpm(
	spec: string,
	staging: string,
	destination: string,
	signal?: AbortSignal,
): Promise<void> {
	let stdout: string;
	try {
		const result = await execFileAsync(
			"npm",
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				staging,
				"--",
				spec,
			],
			{
				...(signal ? { signal } : {}),
				env: { ...process.env, npm_config_ignore_scripts: "true" },
			},
		);
		stdout = result.stdout;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		throw new Error(`npm pack failed: ${message}`);
	}

	let packed: unknown;
	try {
		packed = JSON.parse(stdout);
	} catch {
		throw new Error("npm pack returned an invalid response");
	}
	const filename = firstPackResult(packed)?.filename;
	if (!filename) throw new Error("npm pack did not produce an archive");

	mkdirSync(destination, { recursive: true });
	await extractTar({
		file: resolve(staging, filename),
		cwd: destination,
		strip: 1,
		preservePaths: false,
	});
}

/** Remove an installed plugin directory. Does not touch its PLUGIN_DATA. */
export function uninstall(name: string, targetDir = userPluginsDir()): boolean {
	const destination = join(targetDir, name);
	if (!existsSync(destination)) return false;
	rmSync(destination, { recursive: true, force: true });
	return true;
}
