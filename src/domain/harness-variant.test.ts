import { describe, expect, it } from "vitest";
import {
	DEFAULT_HARNESS_VARIANT,
	harnessVariantChanges,
	harnessVariantFromFlags,
	harnessVariantFromUnknown,
	harnessVariantLabel,
} from "./harness-variant";

describe("harness variants", () => {
	it("parses repeatable and comma-separated flags strictly", () => {
		expect(harnessVariantFromFlags()).toEqual(DEFAULT_HARNESS_VARIANT);
		const variant = harnessVariantFromFlags([
			"memoryWording=rules",
			"toolSurface=lean-pi",
		]);
		expect(variant).toEqual({ memoryWording: "rules", toolSurface: "lean-pi" });
		expect(
			harnessVariantFromFlags(["memoryWording=rules,toolSurface=current"]),
		).toEqual({
			memoryWording: "rules",
			toolSurface: "current",
		});
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
				memoryWording: "rules",
				toolSurface: "unknown",
				extra: true,
			}),
		).toEqual({ memoryWording: "rules", toolSurface: "current" });
		expect(harnessVariantFromUnknown(null)).toEqual(DEFAULT_HARNESS_VARIANT);
		expect(harnessVariantFromUnknown(["rules"])).toEqual(
			DEFAULT_HARNESS_VARIANT,
		);
		const rules = harnessVariantFromFlags(["memoryWording=rules"]);
		expect(harnessVariantChanges(rules)).toEqual({ memoryWording: "rules" });
		expect(harnessVariantLabel(rules)).toBe("memoryWording=rules");
		expect(harnessVariantLabel(DEFAULT_HARNESS_VARIANT)).toBe("default");
	});
});
