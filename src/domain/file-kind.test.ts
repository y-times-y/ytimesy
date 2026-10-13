import { describe, expect, it } from "vitest";
import { fileTypeIconName } from "./file-kind";

describe("fileKindFromPath", () => {
	it("uses the built-in Seti file mappings", () => {
		expect(fileTypeIconName("src/app.ts")).toBe("_typescript");
		expect(fileTypeIconName("src/widget.tsx")).toBe("_react");
		expect(fileTypeIconName("package.json")).toBe("_json");
		expect(fileTypeIconName("src/app.test.ts")).toBe("_typescript_1");
		expect(fileTypeIconName("notes")).toBe("_default");
		expect(fileTypeIconName("mark.svg")).toBe("_svg");
		expect(fileTypeIconName("photo.png")).toBe("_image");
	});
});
