import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	discoverSkills,
	loadPlugin,
	qualifyServerName,
} from "../src/loader.ts";
import {
	expand,
	resolveCommand,
	resolveCwd,
	resolvePluginRelative,
} from "../src/paths.ts";
import { pluginDataDir } from "../src/paths-client.ts";
import { PLUGIN_SCHEMA_ID } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "agent-plugins-test-"));
}

function skill(
	path: string,
	name: string,
	description = "Use this skill for tests.",
): void {
	mkdirSync(path, { recursive: true });
	writeFileSync(
		join(path, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# Test\n`,
	);
}

test("placeholder expansion is single-pass and limited to two exact variables", () => {
	const vars = { PLUGIN_ROOT: "/root/${PLUGIN_DATA}", PLUGIN_DATA: "/data" };
	assert.equal(
		expand("${PLUGIN_ROOT}/x/${PLUGIN_DATA}/${HOME}", vars),
		"/root/${PLUGIN_DATA}/x//data/${HOME}",
	);
});

test("plugin-relative paths and cwd forms enforce containment", () => {
	const root = tempDir();
	const data = tempDir();
	mkdirSync(join(root, "inside"));

	assert.equal(resolvePluginRelative(root, "./inside"), join(root, "inside"));
	assert.equal(resolvePluginRelative(root, "./../escape"), undefined);
	assert.equal(
		resolveCwd("${PLUGIN_ROOT}/inside", {
			PLUGIN_ROOT: root,
			PLUGIN_DATA: data,
		}),
		join(root, "inside"),
	);
	assert.equal(
		resolveCwd("${PLUGIN_DATA}/cache", {
			PLUGIN_ROOT: root,
			PLUGIN_DATA: data,
		}),
		join(data, "cache"),
	);
	assert.equal(
		resolveCwd("/tmp", { PLUGIN_ROOT: root, PLUGIN_DATA: data }),
		undefined,
	);
});

test("user and project instances with the same name get separate PLUGIN_DATA", () => {
	const user = pluginDataDir("same-name", "user", "/user/plugins/same-name");
	const projectA = pluginDataDir(
		"same-name",
		"project",
		"/work/a/.pi/plugins/same-name",
	);
	const projectB = pluginDataDir(
		"same-name",
		"project",
		"/work/b/.pi/plugins/same-name",
	);
	assert.notEqual(projectA, user);
	assert.notEqual(projectA, projectB);
});

test("fixed skills location symlink escape invalidates the component type", (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const root = tempDir();
	const outside = tempDir();
	skill(join(outside, "escaped"), "escaped");
	symlinkSync(outside, join(root, "skills"), "dir");
	const result = discoverSkills(root);
	assert.equal(result.skills.length, 0);
	assert.match(result.diagnostics[0]?.message ?? "", /outside/);
});

test("symlink escapes are rejected", (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const root = tempDir();
	const outside = tempDir();
	symlinkSync(outside, join(root, "escape"), "dir");
	assert.equal(resolvePluginRelative(root, "./escape/file"), undefined);
	assert.equal(resolveCommand(root, "./escape/server"), undefined);
});

test("command accepts exactly bare executable names or contained ./ paths", () => {
	const root = tempDir();
	mkdirSync(join(root, "bin"));
	assert.deepEqual(resolveCommand(root, "node"), {
		kind: "bare",
		command: "node",
	});
	assert.deepEqual(resolveCommand(root, "./bin/server"), {
		kind: "plugin-relative",
		command: join(root, "bin", "server"),
	});
	for (const bad of [
		"/usr/bin/node",
		"../node",
		"bin/node",
		"${PLUGIN_ROOT}/bin/node",
	]) {
		assert.equal(resolveCommand(root, bad), undefined, bad);
	}
});

test("skill discovery is immediate-only and strict Agent Skills compliant", () => {
	const root = tempDir();
	const skills = join(root, "skills");
	skill(join(skills, "good"), "good");
	skill(join(skills, "wrong-dir"), "different-name");
	skill(join(skills, "blank-description"), "blank-description", "   ");
	skill(join(skills, "parent", "nested"), "nested");
	const unknown = join(skills, "unknown-field");
	skill(unknown, "unknown-field");
	writeFileSync(
		join(unknown, "SKILL.md"),
		"---\nname: unknown-field\ndescription: test\nclient-only: true\n---\n",
	);

	const result = discoverSkills(root);
	assert.deepEqual(
		result.skills.map((entry) => entry.dir),
		["good"],
	);
	assert.ok(result.diagnostics.some((d) => d.component === "wrong-dir"));
	assert.ok(
		result.diagnostics.some((d) => d.component === "blank-description"),
	);
	assert.ok(result.diagnostics.some((d) => d.component === "unknown-field"));
});

test("skill whose SKILL.md symlink escapes the plugin root is skipped", (t) => {
	if (process.platform === "win32")
		return t.skip("symlink privileges vary on Windows");
	const root = tempDir();
	const outside = tempDir();
	mkdirSync(join(root, "skills", "escaped"), { recursive: true });
	writeFileSync(
		join(outside, "SKILL.md"),
		"---\nname: escaped\ndescription: test\n---\n",
	);
	symlinkSync(
		join(outside, "SKILL.md"),
		join(root, "skills", "escaped", "SKILL.md"),
	);

	const result = discoverSkills(root);
	assert.equal(result.skills.length, 0);
	assert.match(result.diagnostics[0]?.message ?? "", /outside/);
});

test("loader skips semantically invalid and unsupported MCP entries", () => {
	const root = tempDir();
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: "runtime-filter" }),
	);
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
			mcpServers: {
				valid: { type: "stdio", command: "node" },
				command: { type: "stdio", command: "../escape" },
				cwd: { type: "stdio", command: "node", cwd: "/tmp" },
				legacy: { type: "sse", url: "https://example.com/sse" },
				headers: {
					type: "streamable-http",
					url: "https://example.com/mcp",
					headers: { "X-Public": "value" },
				},
				dynamic: {
					type: "streamable-http",
					url: "https://example.com/$env:HOME",
				},
			},
		}),
	);

	const result = loadPlugin(root, { scope: "user" });
	assert.ok("manifest" in result);
	if (!("manifest" in result)) return;
	assert.deepEqual(
		result.mcpServers.map((server) => server.name),
		["valid"],
	);
	for (const name of ["command", "cwd", "legacy", "headers", "dynamic"]) {
		assert.ok(
			result.diagnostics.some((entry) => entry.component === name),
			name,
		);
	}
});

test("loader preserves component failure isolation", () => {
	const root = tempDir();
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name: "mixed-plugin" }),
	);
	skill(join(root, "skills", "working"), "working");
	writeFileSync(join(root, "mcp.json"), "not json");

	const result = loadPlugin(root, { scope: "user" });
	assert.ok("manifest" in result);
	if (!("manifest" in result)) return;
	assert.deepEqual(
		result.skills.map((entry) => entry.dir),
		["working"],
	);
	assert.equal(result.mcpServers.length, 0);
	assert.ok(result.diagnostics.some((d) => d.section === "7.2.2"));
});

test("server names use an injective adapter-safe encoding", () => {
	assert.equal(
		qualifyServerName("acme.tools", "github/api"),
		"acme_002etools__github_002fapi",
	);
	assert.notEqual(
		qualifyServerName("acme.tools", "a/b"),
		qualifyServerName("acme.tools", "a-b"),
	);
	assert.notEqual(
		qualifyServerName("acme.tools", "__proto__"),
		qualifyServerName("acme.tools", "proto"),
	);
	assert.notEqual(
		qualifyServerName("acme.tools", "\uD800"),
		qualifyServerName("acme.tools", "\uFFFD"),
	);
});
