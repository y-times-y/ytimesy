import { describe, expect, it } from "vitest";
import { DesktopStage } from "./desktop-stage";

describe("DesktopStage", () => {
	it("can be imported during server rendering", () => {
		expect(DesktopStage).toBeTypeOf("function");
	});
});
