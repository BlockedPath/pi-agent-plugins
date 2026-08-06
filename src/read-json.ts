import { readFileSync } from "node:fs";

export type JsonFileResult =
	| { value: unknown }
	| { kind: "read" | "parse"; message: string };

export function readJsonFile(path: string): JsonFileResult {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch (cause) {
		return {
			kind: "read",
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
	try {
		return { value: JSON.parse(text) as unknown };
	} catch (cause) {
		return {
			kind: "parse",
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
}
