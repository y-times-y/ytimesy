import { describe, expect, it } from "vitest";
import {
	fileKindBadge,
	fileKindFromPath,
	vscodeFileIconName,
} from "./file-kind";

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

	it("uses vscode-icons names for real file glyphs", () => {
		expect(vscodeFileIconName("src/app.ts")).toBe(
			"vscode-icons:file-type-typescript",
		);
		expect(vscodeFileIconName("src/widget.tsx")).toBe(
			"vscode-icons:file-type-reactts",
		);
		expect(vscodeFileIconName("package.json")).toBe("vscode-icons:file-type-npm");
		expect(vscodeFileIconName("src/app.test.ts")).toBe(
			"vscode-icons:file-type-testts",
		);
		expect(vscodeFileIconName("notes")).toBe("vscode-icons:default-file");
		expect(vscodeFileIconName("mark.svg")).toBe("catppuccin:svg");
		expect(vscodeFileIconName("photo.png")).toBe("catppuccin:image");
	});
});
