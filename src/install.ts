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
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { x as extractTar } from "tar";

import { loadManifest } from "./manifest.ts";
import { isContainedResolved, resolveExisting, resolveInRoot } from "./paths.ts";
import { userPluginsDir } from "./paths-client.ts";
import type { PluginManifest } from "./types.ts";

const execFileAsync = promisify(execFile);

export type InstallSource =
	| { kind: "git"; url: string; ref?: string; subdir?: string }
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
 * Accepted: `npm:pkg@version`, `owner/repo[:subdir][@ref]` GitHub shorthand,
 * `github.com/user/repo`, `https://…`, `git@host:path`, `git:…`, an optional
 * `@ref` suffix, and local paths.
 */
export function parseSource(spec: string): InstallSource | { error: string } {
	const trimmed = spec.trim();
	if (trimmed.length === 0) return { error: "empty plugin source" };
	if (trimmed.startsWith("npm:")) return parseNpmSource(trimmed);
	if (isLocalSource(trimmed))
		return { kind: "path", path: resolve(expandHome(trimmed)) };
	// GitHub `owner/repo` shorthand is tried before the generic Git parser: only
	// this form carries an optional `:subdir`. A non-shorthand input (e.g. a
	// hostname-shaped `host.tld/path`) returns null and falls through unchanged.
	const shorthand = parseGitShorthand(trimmed);
	if (shorthand) return shorthand;
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

// Owner uses GitHub's account-name rules (letters, digits, hyphen — no dot),
// which is what keeps this form distinct from a hostname-shaped generic Git
// source. Repo additionally allows `.` and `_`.
const SHORTHAND_REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/;

/**
 * Parse GitHub `owner/repo[:subdir][@ref]` shorthand.
 *
 * Returns a Git source, an `{ error }` when the input is shorthand-shaped but
 * its subdirectory is malformed, or `null` when the input is not shorthand at
 * all (so the caller falls through to the generic Git parser).
 */
function parseGitShorthand(
	value: string,
): InstallSource | { error: string } | null {
	// `@` cannot appear in an owner, repo, or a valid subdir, so the first `@`
	// unambiguously begins the ref (which may itself contain `/`).
	const atIndex = value.indexOf("@");
	const beforeRef = atIndex === -1 ? value : value.slice(0, atIndex);
	const ref = atIndex === -1 ? undefined : value.slice(atIndex + 1) || undefined;

	const colonIndex = beforeRef.indexOf(":");
	const repoPart = colonIndex === -1 ? beforeRef : beforeRef.slice(0, colonIndex);
	const subdir = colonIndex === -1 ? undefined : beforeRef.slice(colonIndex + 1);

	const match = SHORTHAND_REPO.exec(repoPart);
	if (!match) return null;

	const owner = match[1];
	const rawRepo = match[2];
	if (!owner || !rawRepo) return null;
	const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
	// `.` and `..` are valid regex matches but not real repositories; fall
	// through so the generic parser reports an unrecognized source.
	if (repo.length === 0 || repo === "." || repo === "..") return null;

	if (subdir !== undefined && !isValidSubdir(subdir)) {
		return { error: `invalid plugin subdirectory: ${subdir}` };
	}

	const url = `https://github.com/${owner}/${repo}`;
	return {
		kind: "git",
		url,
		...(subdir !== undefined ? { subdir } : {}),
		...(ref ? { ref } : {}),
	};
}

/**
 * A shorthand subdirectory is a forward-slash relative path with no traversal.
 * Rejecting `:` and `\` also excludes Windows drive and UNC forms; rejecting
 * empty segments excludes absolute, trailing-slash, and repeated-separator
 * paths.
 */
function isValidSubdir(subdir: string): boolean {
	if (subdir.includes("\\") || subdir.includes(":") || subdir.includes("\0"))
		return false;
	const segments = subdir.split("/");
	return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
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
		// The fetched source and the selected plugin root are distinct: a Git
		// source may name a subdirectory, so we clone the whole repository and
		// then resolve the one directory to install.
		let selectedRoot: string;
		if (source.kind === "git") {
			const fetchedRoot = join(staging, "repository");
			await cloneGit(source, fetchedRoot, options.signal);
			selectedRoot = resolveGitPluginRoot(fetchedRoot, source.subdir);
		} else if (source.kind === "npm") {
			selectedRoot = join(staging, "plugin");
			await packNpm(source.spec, staging, selectedRoot, options.signal);
		} else {
			if (!existsSync(source.path) || !statSync(source.path).isDirectory()) {
				throw new Error(`not a directory: ${source.path}`);
			}
			selectedRoot = join(staging, "plugin");
			cpSync(source.path, selectedRoot, {
				recursive: true,
				dereference: false,
				verbatimSymlinks: true,
			});
		}

		// §4.1/§5.1: a plugin without a valid root manifest is not a plugin.
		const manifestPath = join(selectedRoot, "plugin.json");
		if (!existsSync(manifestPath)) {
			throw new Error(
				"source has no plugin.json at its root; not an Agent Plugin",
			);
		}
		// The manifest we validate must be the manifest we install. A symlinked
		// plugin.json can point outside the selected root (e.g. at a monorepo
		// sibling); loadManifest would follow it, but cpSync copies the link
		// verbatim and it dangles once staging is torn down. Reject that here so
		// a validated install cannot become an unloadable one.
		if (!isContainedResolved(selectedRoot, manifestPath)) {
			throw new Error("plugin.json resolves outside the plugin root");
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
		// verbatimSymlinks keeps relative links relative: without it, cpSync
		// rewrites them to absolute paths into the staging dir, which dangle
		// once staging is deleted.
		cpSync(selectedRoot, destination, {
			recursive: true,
			dereference: false,
			verbatimSymlinks: true,
		});

		return { manifest, root: destination, source };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/**
 * Resolve the plugin directory to install from a cloned repository.
 *
 * With no subdirectory, the repository root is the plugin root. With one, the
 * candidate must resolve inside the filesystem-resolved repository root (via the
 * shared containment helpers, so a symlink cannot escape), exist, and be a
 * directory. Errors distinguish containment escape, a missing path, and the
 * wrong filesystem kind.
 */
export function resolveGitPluginRoot(
	repositoryRoot: string,
	subdir: string | undefined,
): string {
	const root = resolveExisting(repositoryRoot);
	if (subdir === undefined) return root;

	const candidate = resolveInRoot(root, subdir);
	if (!candidate)
		throw new Error(`plugin subdirectory escapes the repository: ${subdir}`);
	if (!existsSync(candidate))
		throw new Error(`plugin subdirectory not found: ${subdir}`);
	if (!statSync(candidate).isDirectory())
		throw new Error(`plugin subdirectory is not a directory: ${subdir}`);
	return resolveExisting(candidate);
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

/**
 * Resolve how to invoke npm without shell metacharacter risks.
 *
 * On Windows, bare `npm` is a `.cmd` shim. `execFile` cannot launch `.cmd`
 * files without `shell: true`, so prefer `node npm-cli.js` when present and
 * only fall back to `npm.cmd` + shell.
 */
function resolveNpmInvocation(packArgs: string[]): {
	command: string;
	args: string[];
	shell: boolean;
} {
	if (process.platform !== "win32") {
		return { command: "npm", args: packArgs, shell: false };
	}
	const npmCli = join(
		dirname(process.execPath),
		"node_modules",
		"npm",
		"bin",
		"npm-cli.js",
	);
	if (!existsSync(npmCli)) {
		return { command: "npm.cmd", args: packArgs, shell: true };
	}
	return {
		command: process.execPath,
		args: [npmCli, ...packArgs],
		shell: false,
	};
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
		const packArgs = [
			"pack",
			"--json",
			"--ignore-scripts",
			"--pack-destination",
			staging,
			"--",
			spec,
		];
		const npm = resolveNpmInvocation(packArgs);
		const result = await execFileAsync(npm.command, npm.args, {
			...(signal ? { signal } : {}),
			shell: npm.shell,
			env: { ...process.env, npm_config_ignore_scripts: "true" },
			windowsHide: true,
		});
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
