import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { install, parseSource } from "../src/install.ts";
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
	const root = tempDir();
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
			qualifiedName: `test-plugin__${name}`,
			config,
		})),
		diagnostics: [],
	};
}

test("stdio projection expands only portable variables and sets reserved env last", () => {
	const plugin = pluginWith({
		local: {
			type: "stdio",
			command: "./bin/server",
			args: ["${PLUGIN_ROOT}/config", "${HOME}"],
			env: { CACHE: "${PLUGIN_DATA}/cache", HOME_LITERAL: "${HOME}" },
			cwd: "${PLUGIN_ROOT}",
		},
	});

	const projection = projectPlugin(plugin);
	const entry = projection.servers["test-plugin__local"];
	assert.equal(entry?.command, join(plugin.root, "bin", "server"));
	assert.deepEqual(entry?.args, [`${plugin.root}/config`, "${HOME}"]);
	assert.equal(entry?.cwd, plugin.root);
	assert.equal(entry?.env?.CACHE, `${plugin.dataDir}/cache`);
	assert.equal(entry?.env?.HOME_LITERAL, "${HOME}");
	assert.equal(entry?.env?.PLUGIN_ROOT, plugin.root);
	assert.equal(entry?.env?.PLUGIN_DATA, plugin.dataDir);
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

test("headerless Streamable HTTP is projected; unsafe headers and declared SSE are skipped", () => {
	const plugin = pluginWith({
		http: { type: "streamable-http", url: "https://example.com/mcp" },
		headers: {
			type: "streamable-http",
			url: "https://example.com/private",
			headers: { "X-Test": "${TOKEN}" },
		},
		legacy: { type: "sse", url: "https://example.com/sse" },
	});
	const projection = projectPlugin(plugin);
	assert.deepEqual(projection.servers["test-plugin__http"], {
		url: "https://example.com/mcp",
	});
	assert.equal(projection.servers["test-plugin__headers"], undefined);
	assert.equal(projection.servers["test-plugin__legacy"], undefined);
	assert.ok(
		projection.diagnostics.some((entry) => entry.message.includes("headers")),
	);
	assert.ok(
		projection.diagnostics.some((entry) => entry.message.includes("SSE")),
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
