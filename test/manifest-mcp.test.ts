import assert from "node:assert/strict";
import test from "node:test";

import { validateManifest, validatePluginName } from "../src/manifest.ts";
import { validateMcpConfig, validateServerEntry } from "../src/mcp-config.ts";
import { MCP_SCHEMA_ID, PI_NAMESPACE, PLUGIN_SCHEMA_ID } from "../src/types.ts";

const PATH = "/plugin/plugin.json";

test("manifest accepts the minimal form", () => {
	const result = validateManifest(
		{ $schema: PLUGIN_SCHEMA_ID, name: "hello-plugin" },
		PATH,
	);
	assert.equal(result.value?.name, "hello-plugin");
	assert.deepEqual(result.diagnostics, []);
});

test("manifest reports and ignores unknown top-level fields", () => {
	const result = validateManifest(
		{ $schema: PLUGIN_SCHEMA_ID, name: "hello", typo: true },
		PATH,
	);
	assert.equal(result.value?.name, "hello");
	assert.match(result.diagnostics[0]?.message ?? "", /unknown manifest field/);
});

test("manifest ignores malformed unimplemented namespaces without validation", () => {
	const result = validateManifest(
		{
			$schema: PLUGIN_SCHEMA_ID,
			name: "hello",
			extensions: { "com.example.unknown": 42 },
		},
		PATH,
	);
	assert.ok(result.value);
	assert.equal(result.diagnostics.length, 0);
});

test("manifest reports malformed data in the implemented namespace", () => {
	const result = validateManifest(
		{
			$schema: PLUGIN_SCHEMA_ID,
			name: "hello",
			extensions: { [PI_NAMESPACE]: false },
		},
		PATH,
	);
	assert.ok(result.value);
	assert.match(result.diagnostics[0]?.message ?? "", /value must be an object/);
});

test("manifest rejects every schema error except the two non-fatal cases", () => {
	const badAuthor = validateManifest(
		{
			$schema: PLUGIN_SCHEMA_ID,
			name: "hello",
			author: { name: "A", organization: "B" },
		},
		PATH,
	);
	assert.equal(badAuthor.value, undefined);
	assert.match(badAuthor.diagnostics[0]?.message ?? "", /unsupported field/);

	const badSchema = validateManifest(
		{ $schema: "https://example.com/schema", name: "hello" },
		PATH,
	);
	assert.equal(badSchema.value, undefined);
});

test("plugin name implements every §5.5 constraint", () => {
	for (const valid of ["a", "my-plugin", "acme.tools", "lint3r"]) {
		assert.equal(validatePluginName(valid), undefined, valid);
	}
	for (const invalid of [
		"",
		"My-Plugin",
		"-start",
		"end-",
		"has--double",
		"too..many",
		"x".repeat(65),
	]) {
		assert.ok(validatePluginName(invalid), invalid);
	}
});

test("server variants are closed and independently validated", () => {
	assert.deepEqual(
		validateServerEntry({ type: "stdio", command: "node", args: ["server.js"] })
			.server,
		{
			type: "stdio",
			command: "node",
			args: ["server.js"],
		},
	);
	assert.match(
		validateServerEntry({
			type: "stdio",
			command: "node",
			url: "https://x.test",
		}).problem ?? "",
		/unsupported field/,
	);
	assert.match(
		validateServerEntry({
			type: "stdio",
			command: "node",
			env: { PLUGIN_ROOT: "bad" },
		}).problem ?? "",
		/reserved/,
	);
	assert.match(
		validateServerEntry({ type: "other" }).problem ?? "",
		/unknown server type/,
	);
});

test("HTTP URL and header restrictions are enforced", () => {
	assert.ok(
		validateServerEntry({
			type: "streamable-http",
			url: "https://example.com/mcp",
		}).server,
	);
	assert.ok(
		validateServerEntry({
			type: "streamable-http",
			url: "http://localhost:3000/mcp",
		}).server,
	);
	assert.ok(
		validateServerEntry({
			type: "streamable-http",
			url: "http://127.0.0.1/mcp",
		}).server,
	);
	assert.match(
		validateServerEntry({
			type: "streamable-http",
			url: "http://example.com/mcp",
		}).problem ?? "",
		/https/,
	);
	assert.match(
		validateServerEntry({
			type: "streamable-http",
			url: "https://u:p@example.com/mcp",
		}).problem ?? "",
		/user information/,
	);
	assert.match(
		validateServerEntry({
			type: "streamable-http",
			url: "https://example.com/mcp#x",
		}).problem ?? "",
		/fragment/,
	);
	assert.match(
		validateServerEntry({
			type: "streamable-http",
			url: "https://example.com/mcp",
			headers: { Authorization: "one", authorization: "two" },
		}).problem ?? "",
		/more than once/,
	);
});

test("top-level MCP failure disables MCP, while one bad entry leaves valid siblings", () => {
	const topLevel = validateMcpConfig(
		{
			$schema: MCP_SCHEMA_ID,
			mcpServers: {},
			extra: true,
		},
		"/plugin/mcp.json",
		PLUGIN_SCHEMA_ID,
	);
	assert.equal(topLevel.value, undefined);

	const entries = validateMcpConfig(
		{
			$schema: MCP_SCHEMA_ID,
			mcpServers: {
				good: { type: "stdio", command: "node" },
				bad: { type: "unknown" },
			},
		},
		"/plugin/mcp.json",
		PLUGIN_SCHEMA_ID,
	);
	assert.deepEqual(Object.keys(entries.value?.mcpServers ?? {}), ["good"]);
	assert.equal(entries.diagnostics[0]?.component, "bad");
});
