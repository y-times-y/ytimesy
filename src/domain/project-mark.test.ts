import { describe, expect, it } from "vitest";
import {
	PROJECT_MARK_TONES,
	projectMark,
	projectMarkInitials,
} from "./project-mark";

function luminance(hex: string) {
	const channel = (offset: number) => {
		const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return ((hi as number) + 0.05) / ((lo as number) + 0.05);
};

describe("projectMarkInitials", () => {
	it("takes one letter from one word and two from a multi-word name", () => {
		expect(projectMarkInitials("ytimesy")).toBe("Y");
		expect(projectMarkInitials("my-cool_app")).toBe("MC");
		expect(projectMarkInitials("  web app ")).toBe("WA");
	});
	it("keeps a whole emoji or accented letter, and never returns empty", () => {
		expect(projectMarkInitials("élan")).toBe("É");
		expect(projectMarkInitials("🚀 launch")).toBe("🚀L");
		expect(projectMarkInitials("---")).toBe("#");
		expect(projectMarkInitials("")).toBe("#");
	});
});

describe("projectMark", () => {
	it("is deterministic for the same project", () => {
		const a = projectMark({ id: "p1", name: "Docs" });
		expect(projectMark({ id: "p1", name: "Docs" })).toEqual(a);
	});
	it("keeps its colour when the project is renamed (seeded by id)", () => {
		expect(projectMark({ id: "p1", name: "Docs" }).background).toBe(
			projectMark({ id: "p1", name: "Handbook" }).background,
		);
	});
	it("spreads different ids across the palette", () => {
		const tones = new Set(
			Array.from(
				{ length: 40 },
				(_, i) => projectMark({ id: `id-${i}`, name: "x" }).background,
			),
		);
		expect(tones.size).toBeGreaterThan(3);
	});
	it("has accessible text contrast (WCAG AA) on every tone", () => {
		for (const tone of PROJECT_MARK_TONES)
			expect(contrast(tone, "#ffffff")).toBeGreaterThanOrEqual(4.5);
	});
});
