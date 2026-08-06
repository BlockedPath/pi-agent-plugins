#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT_FILES = ["package.json", "package-lock.json", "CHANGELOG.md"];
const RELEASE_TYPES = new Set(["patch", "minor", "major"]);

function fail(message) {
	process.stderr.write(`release: ${message}\n`);
	process.exit(1);
}

function print(message) {
	process.stdout.write(`${message}\n`);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (cause) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		fail(`could not read ${path}: ${detail}`);
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
	});
	if (result.error) fail(`${command} failed: ${result.error.message}`);
	if (result.status !== 0) {
		if (options.capture && result.stderr) process.stderr.write(result.stderr);
		fail(`${command} ${args.join(" ")} exited with ${result.status}`);
	}
	return (result.stdout ?? "").trim();
}

function runNpm(args) {
	const bundledNpmCli = join(
		dirname(process.execPath),
		"node_modules",
		"npm",
		"bin",
		"npm-cli.js",
	);
	const npmCli = [process.env.npm_execpath, bundledNpmCli].find(
		(candidate) => candidate && existsSync(candidate),
	);
	if (npmCli) return run(process.execPath, [npmCli, ...args]);
	if (process.platform === "win32") {
		fail("npm-cli.js not found; run this script through npm run release");
	}
	return run("npm", args);
}

function nextVersion(current, releaseType) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
	if (!match) fail(`unsupported current version: ${current}`);
	let major = Number(match[1]);
	let minor = Number(match[2]);
	let patch = Number(match[3]);
	if (releaseType === "major") {
		major += 1;
		minor = 0;
		patch = 0;
	} else if (releaseType === "minor") {
		minor += 1;
		patch = 0;
	} else {
		patch += 1;
	}
	return `${major}.${minor}.${patch}`;
}

function updateChangelog(version, notes) {
	const path = "CHANGELOG.md";
	const changelog = readFileSync(path, "utf8");
	const heading = "# Changelog\n";
	if (!changelog.startsWith(heading)) {
		fail("CHANGELOG.md must start with '# Changelog'");
	}
	const bullets = notes.map((note) => `- ${note}`).join("\n");
	const section = `\n## ${version}\n\n${bullets}\n`;
	writeFileSync(path, `${heading}${section}${changelog.slice(heading.length)}`);
}

function usage() {
	print(`Usage:
  npm run release -- <patch|minor|major> "Release note" ["Another note"]

Options:
  --dry-run  Validate and print the planned release without changing files
  --help     Show this help

Example:
  npm run release -- patch "Fix Windows package installation"`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
	usage();
	process.exit(0);
}

const dryRun = args.includes("--dry-run");
const positional = args.filter((arg) => arg !== "--dry-run");
const [releaseType, ...notes] = positional;
if (!RELEASE_TYPES.has(releaseType)) {
	usage();
	fail("first argument must be patch, minor, or major");
}
if (notes.length === 0) fail("provide at least one changelog note");
if (notes.some((note) => note.trim().length === 0)) {
	fail("changelog notes cannot be empty");
}

const branch = run("git", ["branch", "--show-current"], { capture: true });
if (branch !== "main") fail(`expected branch main, found ${branch || "detached HEAD"}`);

const status = run("git", ["status", "--porcelain"], { capture: true });
if (status) fail("working tree must be clean before releasing");

const packageJson = readJson("package.json");
const version = nextVersion(packageJson.version, releaseType);
const tag = `v${version}`;

print(`Releasing ${packageJson.name} ${tag}`);
for (const note of notes) print(`  - ${note}`);
if (dryRun) {
	print("Dry run complete; no files were changed.");
	process.exit(0);
}

run("git", ["fetch", "origin", "main", "--tags"]);
const head = run("git", ["rev-parse", "HEAD"], { capture: true });
const remoteHead = run("git", ["rev-parse", "origin/main"], { capture: true });
if (head !== remoteHead) fail("local main must exactly match origin/main");

const existingTag = spawnSync("git", ["rev-parse", "--verify", tag], {
	cwd: process.cwd(),
	stdio: "ignore",
});
if (existingTag.status === 0) fail(`tag ${tag} already exists`);

runNpm(["run", "typecheck"]);
runNpm(["test"]);
runNpm(["version", releaseType, "--no-git-tag-version"]);

const updatedPackage = readJson("package.json");
if (updatedPackage.version !== version) {
	fail(`npm produced ${updatedPackage.version}; expected ${version}`);
}
updateChangelog(version, notes);

run("git", ["add", ...ROOT_FILES]);
run("git", ["commit", "-m", `release: ${tag}`]);
run("git", ["tag", "-a", tag, "-m", tag]);
run("git", ["push", "--atomic", "origin", "main", tag]);

print(`Released ${tag}. GitHub Actions will publish both registries.`);
