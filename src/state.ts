/**
 * Client-owned enable/disable state.
 *
 * Enablement UX is explicitly outside the spec, so this is a small local file
 * rather than anything derived from the manifest.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { statePath } from "./paths-client.ts";

export interface PluginState {
	/** Plugin names the user has explicitly disabled. */
	disabled: string[];
	/** Plugin names whose MCP servers the user has approved for execution. */
	trusted: string[];
}

const EMPTY: PluginState = { disabled: [], trusted: [] };

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string")
		: [];
}

/** Byte-order comparison, so persisted state does not vary with the host locale. */
function byCodeUnit(a: string, b: string): number {
	if (a < b) return -1;
	if (a > b) return 1;
	return 0;
}

export function readState(path = statePath()): PluginState {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<
			string,
			unknown
		>;
		return {
			disabled: stringArray(parsed.disabled),
			trusted: stringArray(parsed.trusted),
		};
	} catch {
		return { ...EMPTY };
	}
}

function writeState(state: PluginState, path = statePath()): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`);
	const normalized: PluginState = {
		disabled: [...new Set(state.disabled)].sort(byCodeUnit),
		trusted: [...new Set(state.trusted)].sort(byCodeUnit),
	};
	writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
	renameSync(tmp, path);
}

export function setDisabled(
	name: string,
	disabled: boolean,
	path = statePath(),
): PluginState {
	const state = readState(path);
	const set = new Set(state.disabled);
	if (disabled) set.add(name);
	else set.delete(name);
	const next: PluginState = { ...state, disabled: [...set] };
	writeState(next, path);
	return next;
}

export function setTrustedMany(
	add: readonly string[],
	remove: readonly string[] = [],
	path = statePath(),
): PluginState {
	const state = readState(path);
	const trusted = new Set(state.trusted);
	for (const name of add) trusted.add(name);
	for (const name of remove) trusted.delete(name);
	const next: PluginState = { ...state, trusted: [...trusted] };
	writeState(next, path);
	return next;
}
