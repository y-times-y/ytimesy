import { describe, expect, it } from "vitest";
import { fileKindBadge, fileKindFromPath } from "./file-kind";

describe("fileKindFromPath", () => {
	it("maps common source extensions to distinct kinds", () => {
		expect(fileKindFromPath("src/app.ts")).toBe("typescript");
		expect(fileKindFromPath("src/widget.tsx")).toBe("tsx");
		expect(fileKindFromPath("src/legacy.js")).toBe("javascript");
		expect(fileKindFromPath("src/styles.css")).toBe("css");
		expect(fileKindFromPath("README.md")).toBe("markdown");
		expect(fileKindFromPath("package.json")).toBe("json");
		expect(fileKindFromPath("pnpm-lock.yaml")).toBe("lock");
	});

	it("treats test files as tests even when the extension is ts", () => {
		expect(fileKindFromPath("src/app.test.ts")).toBe("test");
		expect(fileKindFromPath("src/app.spec.tsx")).toBe("test");
	});

	it("keeps a badge for every known kind", () => {
		expect(fileKindBadge("typescript")).toBe("TS");
		expect(fileKindBadge("json")).toBe("{}");
		expect(fileKindBadge("unknown")).toBe("");
	});
});
