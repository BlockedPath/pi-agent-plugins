#!/usr/bin/env node

/**
 * Launch a portable stdio server without exposing plugin-authored values to
 * pi-mcp-adapter's native secret-command and environment interpolation layer.
 */

import { spawn } from "node:child_process";

function fail(message) {
	process.stderr.write(`pi-agent-plugins launcher: ${message}\n`);
	process.exit(1);
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodePayload(encoded) {
	if (typeof encoded !== "string" || encoded === "") fail("missing launch payload");
	let payload;
	try {
		payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		fail("invalid launch payload");
	}
	if (!isRecord(payload)) fail("launch payload must be an object");
	if (typeof payload.command !== "string" || payload.command === "")
		fail("launch payload requires command");
	if (!Array.isArray(payload.args) || payload.args.some((value) => typeof value !== "string"))
		fail("launch payload args must be strings");
	if (!isRecord(payload.env) || Object.values(payload.env).some((value) => typeof value !== "string"))
		fail("launch payload env must contain strings");
	for (const key of ["cwd", "pluginRoot", "pluginData"]) {
		if (typeof payload[key] !== "string" || payload[key] === "")
			fail(`launch payload requires ${key}`);
	}
	return payload;
}

function setEnvironmentValue(environment, key, value) {
	if (process.platform === "win32") {
		const equivalent = key.toLowerCase();
		for (const existing of Object.keys(environment)) {
			if (existing.toLowerCase() === equivalent) delete environment[existing];
		}
	}
	environment[key] = value;
}

const payload = decodePayload(process.argv[2]);
const environment = Object.create(null);
for (const [key, value] of Object.entries(process.env)) {
	if (value !== undefined) setEnvironmentValue(environment, key, value);
}
for (const [key, value] of Object.entries(payload.env)) {
	setEnvironmentValue(environment, key, value);
}
setEnvironmentValue(environment, "PLUGIN_ROOT", payload.pluginRoot);
setEnvironmentValue(environment, "PLUGIN_DATA", payload.pluginData);

const child = spawn(payload.command, payload.args, {
	cwd: payload.cwd,
	env: environment,
	stdio: "inherit",
	shell: false,
	windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		if (!child.killed) child.kill(signal);
	});
}

child.on("error", (error) => {
	process.stderr.write(`pi-agent-plugins launcher: ${error.message}\n`);
	process.exitCode = 1;
});
child.on("exit", (code) => {
	process.exitCode = code ?? 1;
});
