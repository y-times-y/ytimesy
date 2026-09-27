import { describe, expect, it } from "vitest";
import {
	sourceLanguageFromFence,
	sourceLanguageFromPath,
} from "./source-language";

describe("sourceLanguageFromPath", () => {
	it("uses the real extension so Diff can color test files too", () => {
		expect(sourceLanguageFromPath("src/hero.tsx")).toBe("tsx");
		expect(sourceLanguageFromPath("src/app.test.ts")).toBe("typescript");
		expect(sourceLanguageFromPath("config.toml")).toBe("toml");
		expect(sourceLanguageFromPath("todo.py")).toBe("python");
		expect(sourceLanguageFromPath("package.json")).toBe("json");
		expect(sourceLanguageFromPath("main.rs")).toBe("rust");
		expect(sourceLanguageFromPath("compose.yaml")).toBe("yaml");
	});
});

describe("sourceLanguageFromFence", () => {
	it("uses library aliases and keeps unknown fences as plain text", () => {
		expect(sourceLanguageFromFence(null)).toBe("text");
		expect(sourceLanguageFromFence("unrecognized")).toBe("text");
		expect(sourceLanguageFromFence("tsx")).toBe("tsx");
		expect(sourceLanguageFromFence("python")).toBe("python");
	});
});
