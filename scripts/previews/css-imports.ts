import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const IMPORT =
	/(?:import|export)\s[^"']*?["']([^"']+)["']|import\s*["']([^"']+)["']/g;
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModule(from: string, specifier: string): string | null {
	const base = specifier.startsWith("#/")
		? resolve(ROOT, "src", specifier.slice(2))
		: specifier.startsWith(".")
			? resolve(dirname(from), specifier)
			: null;
	if (!base) return null;
	for (const extension of EXTENSIONS) {
		const file = base + extension;
		if (existsSync(file) && /\.(tsx?|css)$/.test(file)) return file;
	}
	return null;
}

/** Every stylesheet the entry's components import, transitively, in first-import order. */
export function stylesheetsImportedBy(entry: string): string[] {
	const seen = new Set<string>();
	const sheets: string[] = [];
	const visit = (file: string) => {
		if (seen.has(file)) return;
		seen.add(file);
		if (file.endsWith(".css")) {
			sheets.push(file);
			return;
		}
		for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
			const next = resolveModule(file, match[1] ?? match[2] ?? "");
			if (next) visit(next);
		}
	};
	visit(resolve(entry));
	return sheets;
}
