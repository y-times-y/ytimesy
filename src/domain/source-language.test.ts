import { describe, expect, it } from "vitest";
import {
	sourceLanguageFromFence,
	sourceLanguageFromPath,
} from "./source-language";

describe("sourceLanguageFromPath", () => {
	it("uses the real extension so Diff can color test files too", () => {
		expect(sourceLanguageFromPath("src/hero.tsx")).toBe("javascript");
		expect(sourceLanguageFromPath("src/app.test.ts")).toBe("javascript");
		expect(sourceLanguageFromPath("todo.py")).toBe("python");
		expect(sourceLanguageFromPath("package.json")).toBe("json");
		expect(sourceLanguageFromPath("main.rs")).toBe("rust");
		expect(sourceLanguageFromPath("compose.yaml")).toBe("yaml");
	});
});

describe("sourceLanguageFromFence", () => {
	it("treats an untagged fence as JavaScript the way Codex colors agent snippets", () => {
		expect(sourceLanguageFromFence(null)).toBe("javascript");
		expect(sourceLanguageFromFence("tsx")).toBe("javascript");
		expect(sourceLanguageFromFence("python")).toBe("python");
	});
});
