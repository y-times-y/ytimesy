import { describe, expect, it } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	harnessVariantChanges,
	harnessVariantFromFlags,
	harnessVariantFromUnknown,
	harnessVariantLabel,
} from "./harness-variant";

describe("harness variants", () => {
	it("defaults to lean-pi tools, the rules wording and observer-written memory", () => {
		expect(DEFAULT_HARNESS_VARIANT).toEqual({
			memoryWording: "rules",
			memoryWriter: "observer",
			toolSurface: "lean-pi",
		});
	});

	it("parses repeatable and comma-separated flags strictly", () => {
		expect(harnessVariantFromFlags()).toEqual(DEFAULT_HARNESS_VARIANT);
		const variant = harnessVariantFromFlags([
			"memoryWording=notes",
			"toolSurface=current",
		]);
		expect(variant).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "current",
		});
		expect(
			harnessVariantFromFlags(["memoryWording=notes,toolSurface=lean-native"]),
		).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "lean-native",
		});
		expect(
			harnessVariantFromFlags(["memoryWording=notes,memoryWriter=both"]),
		).toMatchObject({ memoryWording: "notes", memoryWriter: "both" });
		expect(() => harnessVariantFromFlags(["memoryWriter=nobody"])).toThrow(
			"accepts both, agent, observer",
		);
		expect(() => harnessVariantFromFlags(["memoryWording=loud"])).toThrow(
			"accepts notes, rules",
		);
		expect(() => harnessVariantFromFlags(["nope=1"])).toThrow("key=value");
		expect(() => harnessVariantFromFlags(["memoryWording"])).toThrow(
			"key=value",
		);
	});

	it("reads stored rows leniently and labels only the changes", () => {
		expect(
			harnessVariantFromUnknown({
				memoryWording: "notes",
				toolSurface: "unknown",
				extra: true,
			}),
		).toEqual({
			memoryWording: "notes",
			memoryWriter: "observer",
			toolSurface: "lean-pi",
		});
		expect(harnessVariantFromUnknown({ memoryWriter: "agent" })).toEqual({
			...DEFAULT_HARNESS_VARIANT,
			memoryWriter: "agent",
		});
		expect(harnessVariantFromUnknown(null)).toEqual(DEFAULT_HARNESS_VARIANT);
		expect(harnessVariantFromUnknown(["rules"])).toEqual(
			DEFAULT_HARNESS_VARIANT,
		);
		const notes = harnessVariantFromFlags(["memoryWording=notes"]);
		expect(harnessVariantChanges(notes)).toEqual({ memoryWording: "notes" });
		expect(harnessVariantLabel(notes)).toBe("memoryWording=notes");
		expect(harnessVariantLabel(DEFAULT_HARNESS_VARIANT)).toBe("default");
		expect(
			harnessVariantLabel(
				harnessVariantFromFlags(["memoryWriter=agent,memoryWording=notes"]),
			),
		).toBe("memoryWording=notes,memoryWriter=agent");
	});
});
