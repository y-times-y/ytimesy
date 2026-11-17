import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * `boxTurnPorts` and the client under it must not (even transitively, through
 * a value import) reach a database adapter, a provider SDK or a vault: the
 * box holds none of those secrets (docs/turn-runner-boxes.md). Type-only
 * imports are erased and do not count.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../..");

function resolveImport(from: string, specifier: string): string | null {
	const base = specifier.startsWith("#/")
		? resolve(SRC, specifier.slice(2))
		: specifier.startsWith(".")
			? resolve(dirname(from), specifier)
			: null;
	if (!base) return null;
	for (const candidate of [`${base}.ts`, `${base}/index.ts`])
		if (existsSync(candidate)) return candidate;
	return null;
}

function valueImports(file: string) {
	const text = readFileSync(file, "utf8");
	const found: string[] = [];
	for (const match of text.matchAll(
		/^(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+"([^"]+)"/gm,
	))
		found.push(match[1] as string);
	for (const match of text.matchAll(/^import\s+"([^"]+)"/gm))
		found.push(match[1] as string);
	return found;
}

function closure(entry: string) {
	const seen = new Set<string>();
	const bare = new Set<string>();
	const queue = [entry];
	while (queue.length) {
		const file = queue.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		for (const specifier of valueImports(file)) {
			const next = resolveImport(file, specifier);
			if (next) queue.push(next);
			else if (!specifier.startsWith(".") && !specifier.startsWith("#/"))
				bare.add(specifier);
		}
	}
	return { files: [...seen].map((file) => file.slice(SRC.length + 1)), bare };
}

describe("what a box's ports load", () => {
	for (const entry of [
		"server/jobs/turn-box-ports.ts",
		"server/jobs/turn-box-client.ts",
		"server/jobs/box-secrets-guard.ts",
	]) {
		it(`${entry} imports no database adapter, provider SDK or server service`, () => {
			const { files, bare } = closure(resolve(SRC, entry));
			// The walk really followed imports (not an empty closure).
			expect(files.length).toBeGreaterThanOrEqual(1);
			expect(
				files.filter((file) => file.startsWith("server/adapters/")),
			).toEqual([]);
			expect(
				files.filter((file) => file.startsWith("server/services/")),
			).toEqual([]);
			for (const name of [
				"pg",
				"postgres",
				"@ai-sdk/openai",
				"@ai-sdk/anthropic",
				"freestyle",
			])
				expect(bare.has(name), name).toBe(false);
			expect(bare.has("pg")).toBe(false);
		});
	}
});
