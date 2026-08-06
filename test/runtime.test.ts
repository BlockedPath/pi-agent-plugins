import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginRuntime, pluginTrustKey } from "../src/runtime.ts";
import { PLUGIN_SCHEMA_ID } from "../src/types.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "agent-plugins-runtime-test-"));
}

function createPlugin(root: string, name: string): void {
	mkdirSync(root, { recursive: true });
	writeFileSync(
		join(root, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA_ID, name }),
	);
}

test("legacy user trust cannot be inherited by a project plugin with the same name", () => {
	const agentDir = tempDir();
	const project = tempDir();
	createPlugin(join(agentDir, "plugins", "shared-name"), "shared-name");
	createPlugin(join(project, ".pi", "plugins", "shared-name"), "shared-name");
	mkdirSync(join(agentDir, "agent-plugins"), { recursive: true });
	writeFileSync(
		join(agentDir, "agent-plugins", "state.json"),
		JSON.stringify({ disabled: [], trusted: ["shared-name"] }),
	);

	const previous = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	try {
		const runtime = new PluginRuntime();
		runtime.startSession(project, true);
		const active = runtime.find("shared-name");
		assert.ok(active);
		assert.equal(active.scope, "project");
		assert.equal(runtime.registry.trusted.has("shared-name"), false);
		assert.match(active.dataDir, /plugin-data[/\\]project/);

		runtime.trust("shared-name");
		assert.equal(runtime.registry.trusted.has("shared-name"), true);
		const raw: unknown = JSON.parse(
			readFileSync(join(agentDir, "agent-plugins", "state.json"), "utf-8"),
		);
		assert.ok(typeof raw === "object" && raw !== null && !Array.isArray(raw));
		const trusted = (raw as { trusted?: unknown }).trusted;
		assert.ok(Array.isArray(trusted));
		assert.ok(trusted.includes(pluginTrustKey(active)));
	} finally {
		if (previous === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous;
	}
});
