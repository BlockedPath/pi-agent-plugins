/** Strict Agent Skills validation for plugin-discovered skills (§7.1). */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { parseDocument } from "yaml";

import { warning, type Diagnostic } from "./types.ts";

const SKILL_NAME = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

interface SkillFrontmatter {
	name: string;
	description: string;
}

function frontmatterOf(text: string): string | undefined {
	const normalized = text.startsWith("\uFEFF") ? text.slice(1) : text;
	if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n"))
		return undefined;
	const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	return match?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptionalFields(
	raw: Record<string, unknown>,
): string | undefined {
	if (raw.license !== undefined && typeof raw.license !== "string")
		return "license must be a string";
	if (raw.compatibility !== undefined) {
		if (typeof raw.compatibility !== "string")
			return "compatibility must be a string";
		if (raw.compatibility.length === 0 || raw.compatibility.length > 500) {
			return "compatibility must be 1-500 characters when provided";
		}
	}
	if (
		raw["allowed-tools"] !== undefined &&
		typeof raw["allowed-tools"] !== "string"
	) {
		return "allowed-tools must be a space-separated string";
	}
	if (raw.metadata !== undefined) {
		if (!isRecord(raw.metadata))
			return "metadata must be a string-to-string mapping";
		if (
			Object.values(raw.metadata).some((value) => typeof value !== "string")
		) {
			return "metadata values must all be strings";
		}
	}
	return undefined;
}

function validateFrontmatter(
	raw: unknown,
	parentName: string,
): { value?: SkillFrontmatter; problem?: string } {
	if (!isRecord(raw)) return { problem: "YAML frontmatter must be an object" };
	if (typeof raw.name !== "string")
		return { problem: "name is required and must be a string" };
	if (raw.name.length > 64 || !SKILL_NAME.test(raw.name)) {
		return {
			problem:
				"name must be 1-64 lowercase letters, digits, or hyphens, without leading, trailing, or consecutive hyphens",
		};
	}
	if (raw.name !== parentName)
		return {
			problem: `name "${raw.name}" must match parent directory "${parentName}"`,
		};
	if (
		typeof raw.description !== "string" ||
		raw.description.length === 0 ||
		raw.description.length > 1024
	) {
		return { problem: "description is required and must be 1-1024 characters" };
	}
	const optionalProblem = validateOptionalFields(raw);
	if (optionalProblem) return { problem: optionalProblem };
	return { value: { name: raw.name, description: raw.description } };
}

/**
 * Validate one `SKILL.md` against the Agent Skills specification.
 * A failure skips only this skill while siblings and MCP servers continue.
 */
export function validateSkillFile(path: string): {
	valid: boolean;
	diagnostics: Diagnostic[];
} {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return {
			valid: false,
			diagnostics: [
				warning("7.1", `skipping skill: cannot read SKILL.md: ${message}`, {
					path,
				}),
			],
		};
	}

	const frontmatter = frontmatterOf(text);
	if (frontmatter === undefined) {
		return {
			valid: false,
			diagnostics: [
				warning("7.1", "skipping skill: SKILL.md requires YAML frontmatter", {
					path,
				}),
			],
		};
	}

	const document = parseDocument(frontmatter, { uniqueKeys: true });
	if (document.errors.length > 0) {
		return {
			valid: false,
			diagnostics: [
				warning(
					"7.1",
					`skipping skill: invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`,
					{ path },
				),
			],
		};
	}

	const result = validateFrontmatter(document.toJS(), basename(dirname(path)));
	if (!result.value) {
		return {
			valid: false,
			diagnostics: [
				warning(
					"7.1",
					`skipping skill: ${result.problem ?? "invalid frontmatter"}`,
					{
						path,
						component: basename(dirname(path)),
					},
				),
			],
		};
	}
	return { valid: true, diagnostics: [] };
}
