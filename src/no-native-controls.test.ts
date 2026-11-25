import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname);
/** Files that may mention native controls: this guard and tests asserting their absence. */
const FORBIDDEN = [
	{ name: "<select>", pattern: /<select[\s>]/ },
	{ name: "<option>", pattern: /<option[\s>]/ },
	{
		name: "native date/colour input",
		pattern: /type=["'](date|datetime-local|month|week|time|color)["']/,
	},
	{
		name: "window.confirm/alert/prompt",
		pattern: /window\.(confirm|alert|prompt)\(/,
	},
];
/** Truly needed exceptions, each with its reason. */
const ALLOWLIST = new Set<string>([
	// The auth scaffold's "datetime" field type pairs the Calendar popover with a
	// time-of-day input. ytimesy configures no datetime auth field, so it never renders.
	"components/auth/additional-field.tsx",
]);

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sources(path);
		if (!/\.(tsx|ts)$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
		return [path];
	});
}

describe("no browser-native controls", () => {
	it("uses MenuSelect and in-app confirmations, never native ones", () => {
		const hits = sources(root).flatMap((file) => {
			const rel = relative(root, file);
			if (ALLOWLIST.has(rel)) return [];
			const text = readFileSync(file, "utf8");
			return FORBIDDEN.filter((f) => f.pattern.test(text)).map(
				(f) => `${rel}: ${f.name}`,
			);
		});
		expect(hits).toEqual([]);
	});
});
