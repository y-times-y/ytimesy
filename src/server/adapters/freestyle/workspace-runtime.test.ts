import { describe, expect, it } from "vitest";
import { UnconfiguredWorkspaceRuntime } from "../workspace-runtime";
import {
	FreestyleWorkspaceRuntime,
	workspaceRuntimeFromEnv,
} from "./workspace-runtime";

describe("workspaceRuntimeFromEnv", () => {
	it("stays unconfigured until a Freestyle API key is present", () => {
		expect(workspaceRuntimeFromEnv({})).toBeInstanceOf(
			UnconfiguredWorkspaceRuntime,
		);
		expect(workspaceRuntimeFromEnv({ FREESTYLE_API_KEY: "  " })).toBeInstanceOf(
			UnconfiguredWorkspaceRuntime,
		);
		expect(
			workspaceRuntimeFromEnv({ FREESTYLE_API_KEY: "fs_test" }),
		).toBeInstanceOf(FreestyleWorkspaceRuntime);
	});
});
