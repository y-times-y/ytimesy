import { expect, it } from "vitest";
import {
	harnessToolSurface,
	implementedToolSurfaces,
	surfaceInstructions,
} from "./harness-tool-surfaces";

it("offers the current tools unchanged and refuses reserved surfaces", () => {
	const tools = { read_file: {} } as never;
	const current = harnessToolSurface("current");
	expect(
		current.tools({
			tools,
			shellBuilder: true,
			writable: true,
			freeformPatch: false,
			nativePatch: false,
		}),
	).toBe(tools);
	expect(surfaceInstructions(current, tools, "prompt")).toBe("prompt");
	expect(implementedToolSurfaces()).toEqual(["current"]);
	expect(() => harnessToolSurface("lean-native")).toThrow("not implemented");
});
