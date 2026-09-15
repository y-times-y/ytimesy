import { describe, expect, it } from "vitest";
import {
	RIGKIT_NODE_GAP,
	rigkitPreparationStatus,
	selectedWorkspacePreparation,
} from "./workspace-preparation";

describe("workspace preparation backend", () => {
	it("uses Freestyle clone-and-install while Rigkit cannot run in the Node worker", () => {
		expect(selectedWorkspacePreparation()).toEqual({
			method: "clone-and-install",
			host: "freestyle",
		});
		expect(rigkitPreparationStatus()).toEqual({
			method: "rigkit",
			host: "freestyle",
			available: false,
			reason: RIGKIT_NODE_GAP,
		});
	});
});
