import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function serverFunctionFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return serverFunctionFiles(path);
		return entry.name.endsWith(".fn.ts") ? [path] : [];
	});
}

it("bounds every string a server function accepts", () => {
	const unbounded = serverFunctionFiles("src").flatMap((file) => {
		const text = readFileSync(file, "utf8");
		// Each z.string() with the method calls chained after it, over lines.
		return [...text.matchAll(/z\s*\.string\(\)(?:\s*\.[a-zA-Z]+\([^)]*\))*/g)]
			.map((match) => match[0])
			.filter((chain) => !/\.(max|length|uuid|regex)\(/.test(chain))
			.map((chain) => `${file}: ${chain}`);
	});
	expect(unbounded).toEqual([]);
});
