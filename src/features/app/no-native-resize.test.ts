import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

function stylesheets(folder: string): string[] {
	return readdirSync(folder).flatMap((name) => {
		const path = join(folder, name);
		if (statSync(path).isDirectory()) return stylesheets(path);
		return path.endsWith(".css") ? [path] : [];
	});
}

const root = join(import.meta.dirname, "..", "..");

it("shows no native drag-to-resize grip on any text box", () => {
	const offenders = stylesheets(root).flatMap((path) =>
		readFileSync(path, "utf8")
			.split("\n")
			.flatMap((line, index) => {
				const value = /^\s*resize\s*:\s*([^;\s]+)/.exec(line)?.[1];
				return value && value !== "none"
					? [`${path.slice(root.length + 1)}:${index + 1} ${line.trim()}`]
					: [];
			}),
	);
	expect(offenders).toEqual([]);
});

it("turns the grip off for every textarea in one place", () => {
	const base = readFileSync(join(root, "styles.css"), "utf8");
	expect(base).toMatch(/\btextarea\s*\{[^}]*resize:\s*none/);
});
