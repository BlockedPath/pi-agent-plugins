import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { install, parseSource } from "../src/install.ts";
import { qualifyServerName } from "../src/loader.ts";
import {
	prepareDataDirs,
	projectPlugin,
	syncAdapterConfig,
} from "../src/mcp-bridge.ts";
import {
	PLUGIN_SCHEMA_ID,
	type LoadedPlugin,
	type PluginMcpServer,
} from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "agent-plugins-bridge-test-"));
}

function readJson<T>(path: string): T {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (cause) {
		assert.fail(`invalid JSON fixture: ${String(cause)}`);
	}
	assert.ok(
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
	);
	return parsed as T;
}

function pluginWith(servers: Record<string, PluginMcpServer>): LoadedPlugin {
	const root = realpathSync(tempDir());
	const dataDir = join(tempDir(), "data");
	mkdirSync(join(root, "bin"), { recursive: true });
	return {
		manifest: { $schema: PLUGIN_SCHEMA_ID, name: "test.plugin" },
		root,
		dataDir,
		scope: "user",
		enabled: true,
		skills: [],
		mcpServers: Object.entries(servers).map(([name, config]) => ({
			name,
			qualifiedName: qualifyServerName("test.plugin", name),
			config,
		})),
		diagnostics: [],
	};
}

test("stdio launcher preserves opaque values and applies portable variables", () => {
	const script = [
		"process.stdout.write(JSON.stringify({",
		"arg: process.argv[1],",
		"cache: process.env.CACHE,",
		"literal: process.env.HOME_LITERAL,",
		"bang: process.env.BANG,",
		"root: process.env.PLUGIN_ROOT,",
		"data: process.env.PLUGIN_DATA,",
		"cwd: process.cwd()",
		"}))",
	].join("");
	const plugin = pluginWith({
		local: {
			type: "stdio",
			command: "node",
			args: ["-e", script, "${HOME}"],
			env: {
				CACHE: "${PLUGIN_DATA}/cache",
				HOME_LITERAL: "${HOME}",
				BANG: "!printf should-not-run",
			},
			cwd: "${PLUGIN_ROOT}",
		},
	});

	const projection = projectPlugin(plugin);
	const entry = projection.servers[qualifyServerName("test.plugin", "local")];
	assert.equal(entry?.command, process.execPath);
	assert.equal(entry?.env, undefined);
	assert.equal(entry?.cwd, undefined);
	const launched = spawnSync(entry?.command ?? "", entry?.args ?? [], {
		encoding: "utf8",
	});
	assert.equal(launched.status, 0, launched.stderr);
	let output: unknown;
	try {
		output = JSON.parse(launched.stdout);
	} catch (cause) {
		assert.fail(`launcher returned invalid JSON: ${String(cause)}`);
	}
	assert.deepEqual(output, {
		arg: "${HOME}",
		cache: `${plugin.dataDir}/cache`,
		literal: "${HOME}",
		bang: "!printf should-not-run",
		root: plugin.root,
		data: plugin.dataDir,
		cwd: plugin.root,
	});
});

test("unwritable PLUGIN_DATA skips only stdio entries", () => {
	const plugin = pluginWith({
		local: { type: "stdio", command: "node" },
		remote: { type: "streamable-http", url: "https://example.com/mcp" },
	});
	const notDirectory = join(tempDir(), "data-file");
	writeFileSync(notDirectory, "not a directory");
	plugin.dataDir = notDirectory;

	const prepared = prepareDataDirs([plugin]);
	assert.deepEqual(
		prepared.plugins[0]?.mcpServers.map((server) => server.name),
		["remote"],
	);
	assert.match(prepared.diagnostics[0]?.message ?? "", /not writable/);
});

test("only literal-safe headerless Streamable HTTP is projected", () => {
	const plugin = pluginWith({
		http: { type: "streamable-http", url: "https://example.com/mcp" },
		headers: {
			type: "streamable-http",
			url: "https://example.com/private",
			headers: { "X-Test": "${TOKEN}" },
		},
		legacy: { type: "sse", url: "https://example.com/sse" },
		dynamic: {
			type: "streamable-http",
			url: "https://example.com/${HOME}",
		},
	});
	const projection = projectPlugin(plugin);
	assert.deepEqual(
		projection.servers[qualifyServerName("test.plugin", "http")],
		{ url: "https://example.com/mcp" },
	);
	assert.equal(
		projection.servers[qualifyServerName("test.plugin", "headers")],
		undefined,
	);
	assert.equal(
		projection.servers[qualifyServerName("test.plugin", "legacy")],
		undefined,
	);
	assert.equal(
		projection.servers[qualifyServerName("test.plugin", "dynamic")],
		undefined,
	);
	assert.ok(
		projection.diagnostics.some((entry) => entry.message.includes("headers")),
	);
	assert.ok(
		projection.diagnostics.some((entry) => entry.message.includes("SSE")),
	);
	assert.ok(
		projection.diagnostics.some((entry) =>
			entry.message.includes("cannot preserve literally"),
		),
	);
});

test("managed config sync preserves foreign entries and prunes only ledger-owned entries", () => {
	const dir = tempDir();
	const configPath = join(dir, "mcp.json");
	const ledgerPath = join(dir, "ledger.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			mcpServers: {
				foreign: { command: "foreign" },
				stale: { command: "old" },
			},
			settings: { directTools: false },
		}),
	);
	writeFileSync(ledgerPath, JSON.stringify({ managed: ["stale"] }));

	const result = syncAdapterConfig(
		{
			servers: {
				current: { command: "node" },
				foreign: { command: "replace" },
			},
			diagnostics: [],
		},
		configPath,
		ledgerPath,
	);
	assert.equal(result.changed, true);

	const written = readJson<{
		mcpServers: Record<string, { command: string }>;
		settings: { directTools: boolean };
	}>(configPath);
	assert.equal(written.mcpServers.foreign?.command, "foreign");
	assert.equal(written.mcpServers.stale, undefined);
	assert.equal(written.mcpServers.current?.command, "node");
	assert.equal(written.settings.directTools, false);

	const ledger = readJson<{ managed: string[] }>(ledgerPath);
	assert.deepEqual(ledger.managed, ["current"]);
});

test("managed config sync refuses to overwrite corrupt user configuration", () => {
	const dir = tempDir();
	const configPath = join(dir, "mcp.json");
	const ledgerPath = join(dir, "ledger.json");
	writeFileSync(configPath, "{broken");

	const result = syncAdapterConfig(
		{ servers: { current: { command: "node" } }, diagnostics: [] },
		configPath,
		ledgerPath,
	);
	assert.equal(result.changed, false);
	assert.match(
		result.diagnostics.at(-1)?.message ?? "",
		/refusing to overwrite/,
	);
	assert.equal(readFileSync(configPath, "utf-8"), "{broken");
});

test("npm install stages and validates an npm package", async () => {
	const source = tempDir();
	const target = tempDir();
	writeFileSync(
		join(source, "package.json"),
		JSON.stringify({ name: "fixture-agent-plugin", version: "1.0.0" }),
	);
	writeFileSync(
		join(source, "plugin.json"),
		JSON.stringify({
			$schema: PLUGIN_SCHEMA_ID,
			name: "fixture-agent-plugin",
		}),
	);

	const result = await install(
		{ kind: "npm", spec: source },
		{ targetDir: target },
	);
	assert.equal(result.manifest.name, "fixture-agent-plugin");
	assert.ok(
		readFileSync(join(result.root, "plugin.json"), "utf-8").includes(
			"fixture-agent-plugin",
		),
	);
});

test("install source parser recognizes npm, local, hosted, and pinned git sources", () => {
	assert.deepEqual(parseSource("npm:@acme/plugin@1.2.3"), {
		kind: "npm",
		spec: "@acme/plugin@1.2.3",
	});
	assert.deepEqual(parseSource("./plugin"), {
		kind: "path",
		path: join(process.cwd(), "plugin"),
	});
	assert.deepEqual(parseSource("github.com/acme/plugin@v1"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
		ref: "v1",
	});
	assert.deepEqual(parseSource("git:https://example.com/acme/plugin.git"), {
		kind: "git",
		url: "https://example.com/acme/plugin.git",
	});
	assert.ok("error" in parseSource("not a source"));
});

test("install source parser accepts GitHub owner/repo shorthand with optional subdir and ref", () => {
	assert.deepEqual(parseSource("Frameio/claude-plugins"), {
		kind: "git",
		url: "https://github.com/Frameio/claude-plugins",
	});
	assert.deepEqual(parseSource("Frameio/claude-plugins:plugins/infra-aws"), {
		kind: "git",
		url: "https://github.com/Frameio/claude-plugins",
		subdir: "plugins/infra-aws",
	});
	assert.deepEqual(parseSource("Frameio/claude-plugins@main"), {
		kind: "git",
		url: "https://github.com/Frameio/claude-plugins",
		ref: "main",
	});
	assert.deepEqual(
		parseSource("Frameio/claude-plugins:plugins/infra-aws@main"),
		{
			kind: "git",
			url: "https://github.com/Frameio/claude-plugins",
			subdir: "plugins/infra-aws",
			ref: "main",
		},
	);
	// Trailing .git is stripped from the repo name, with or without a subdir.
	assert.deepEqual(parseSource("acme/plugin.git:sub"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
		subdir: "sub",
	});
	assert.deepEqual(parseSource("acme/plugin.git"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
	});
	// A trailing bare `@` carries no ref.
	assert.deepEqual(parseSource("acme/plugin@"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
	});
	// A ref may itself contain slashes.
	assert.deepEqual(parseSource("acme/plugin@feature/x"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
		ref: "feature/x",
	});
});

test("install source parser keeps hostname-shaped forms on the generic git path", () => {
	// A dotted first segment is a hostname, not a shorthand owner: unchanged.
	assert.deepEqual(parseSource("github.com/acme/plugin@v1"), {
		kind: "git",
		url: "https://github.com/acme/plugin",
		ref: "v1",
	});
});

test("install source parser rejects shorthand whose repo is a traversal name", () => {
	for (const source of ["acme/..", "acme/."]) {
		assert.ok("error" in parseSource(source), source);
	}
});

test("install source parser rejects malformed shorthand subdirectories", () => {
	for (const source of [
		"Frameio/claude-plugins:",
		"Frameio/claude-plugins:../infra-aws",
		"Frameio/claude-plugins:plugins/../infra-aws",
		"Frameio/claude-plugins:/plugins/infra-aws",
		"Frameio/claude-plugins:./plugins/infra-aws",
		"Frameio/claude-plugins:plugins\\infra-aws",
		"Frameio/claude-plugins:plugins//infra-aws",
	]) {
		assert.ok("error" in parseSource(source), source);
	}
});

/** Initialize a committed, network-free Git repository fixture. */
function initGitRepo(): { dir: string; commitAll: () => void } {
	const dir = tempDir();
	const git = (...args: string[]): void => {
		const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
		if (result.status !== 0)
			assert.fail(`git ${args.join(" ")} failed: ${result.stderr}`);
	};
	git("init", "-q");
	git("config", "user.email", "fixture@example.com");
	git("config", "user.name", "Fixture");
	return {
		dir,
		commitAll: () => {
			git("add", "-A");
			git("commit", "-q", "-m", "fixture");
		},
	};
}

function writePlugin(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name }),
	);
}

test("git install selects only the named subdirectory as the plugin root", async () => {
	const repo = initGitRepo();
	writePlugin(join(repo.dir, "plugins", "one"), "fixture-subdir-one");
	writePlugin(join(repo.dir, "plugins", "two"), "fixture-subdir-two");
	mkdirSync(join(repo.dir, "unrelated"), { recursive: true });
	writeFileSync(join(repo.dir, "unrelated", "marker.txt"), "sibling");
	repo.commitAll();

	const target = tempDir();
	const result = await install(
		{ kind: "git", url: repo.dir, subdir: "plugins/one" },
		{ targetDir: target },
	);

	assert.equal(result.manifest.name, "fixture-subdir-one");
	assert.equal(result.root, join(target, "fixture-subdir-one"));
	assert.ok(existsSync(join(result.root, "plugin.json")));
	// Only the selected directory is copied — no repository siblings.
	assert.ok(!existsSync(join(result.root, "unrelated")));
	assert.ok(!existsSync(join(result.root, "two")));
	assert.ok(!existsSync(join(result.root, "plugins")));
});

test("git install preserves a contained relative symlink after staging teardown", async (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const repo = initGitRepo();
	const sub = join(repo.dir, "plugins", "one");
	mkdirSync(sub, { recursive: true });
	writeFileSync(
		join(sub, "real.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: "fixture-relsym" }),
	);
	// A relative symlink that stays inside the selected root.
	symlinkSync("./real.json", join(sub, "plugin.json"));
	repo.commitAll();

	const target = tempDir();
	const result = await install(
		{ kind: "git", url: repo.dir, subdir: "plugins/one" },
		{ targetDir: target },
	);

	assert.equal(result.manifest.name, "fixture-relsym");
	// install() deletes staging in its finally; a rewritten absolute link would
	// now dangle. existsSync follows the link, so this asserts it still resolves.
	assert.ok(existsSync(join(result.root, "plugin.json")));
	assert.ok(existsSync(join(result.root, "real.json")));
});

test("git install without a subdirectory installs the repository root and drops .git", async () => {
	const repo = initGitRepo();
	writePlugin(repo.dir, "fixture-root-plugin");
	repo.commitAll();

	const target = tempDir();
	const result = await install(
		{ kind: "git", url: repo.dir },
		{ targetDir: target },
	);

	assert.equal(result.manifest.name, "fixture-root-plugin");
	assert.ok(existsSync(join(result.root, "plugin.json")));
	// The shallow clone's .git is not part of the package.
	assert.ok(!existsSync(join(result.root, ".git")));
});

test("git install rejects a subdirectory whose plugin.json escapes it via symlink", async (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const repo = initGitRepo();
	// A sibling holds a real, valid manifest.
	writePlugin(join(repo.dir, "plugins", "real"), "fixture-real");
	// The selected subdirectory's plugin.json is a symlink to that sibling.
	mkdirSync(join(repo.dir, "plugins", "one"), { recursive: true });
	try {
		symlinkSync(
			join("..", "real", "plugin.json"),
			join(repo.dir, "plugins", "one", "plugin.json"),
		);
	} catch (cause) {
		return void assert.ok(true, `symlinks unavailable: ${String(cause)}`);
	}
	repo.commitAll();

	await assert.rejects(
		install(
			{ kind: "git", url: repo.dir, subdir: "plugins/one" },
			{ targetDir: tempDir() },
		),
		/plugin\.json resolves outside/,
	);
});

test("git install rejects a missing subdirectory", async () => {
	const repo = initGitRepo();
	writePlugin(join(repo.dir, "plugins", "one"), "fixture-subdir-one");
	repo.commitAll();

	await assert.rejects(
		install(
			{ kind: "git", url: repo.dir, subdir: "plugins/absent" },
			{ targetDir: tempDir() },
		),
		/subdirectory not found/,
	);
});

test("git install rejects a subdirectory that is a regular file", async () => {
	const repo = initGitRepo();
	writePlugin(join(repo.dir, "plugins", "one"), "fixture-subdir-one");
	repo.commitAll();

	await assert.rejects(
		install(
			{ kind: "git", url: repo.dir, subdir: "plugins/one/plugin.json" },
			{ targetDir: tempDir() },
		),
		/subdirectory is not a directory/,
	);
});

test("git install rejects a subdirectory symlinked outside the repository", async (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const outside = tempDir();
	writePlugin(join(outside, "evil"), "fixture-evil");

	const repo = initGitRepo();
	writePlugin(join(repo.dir, "plugins", "one"), "fixture-subdir-one");
	try {
		symlinkSync(join(outside, "evil"), join(repo.dir, "escape"));
	} catch (cause) {
		// Symlink creation is unavailable (e.g. restricted CI/Windows).
		return void assert.ok(true, `symlinks unavailable: ${String(cause)}`);
	}
	repo.commitAll();

	await assert.rejects(
		install(
			{ kind: "git", url: repo.dir, subdir: "escape" },
			{ targetDir: tempDir() },
		),
		/escapes the repository/,
	);
});
