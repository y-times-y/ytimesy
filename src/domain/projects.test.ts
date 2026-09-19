import { describe, expect, it } from "vitest";
import {
	projectFolderName,
	projectMachineRefsToDestroy,
	selectedProjectIdAfterDelete,
} from "./projects";

describe("projectFolderName", () => {
	it("uses the repository name after the owner", () => {
		expect(projectFolderName("y-times-y/ytimesy")).toBe("ytimesy");
		expect(projectFolderName("ytimesy")).toBe("ytimesy");
	});
});

describe("selectedProjectIdAfterDelete", () => {
	const projects = [{ id: "a" }, { id: "b" }, { id: "c" }];

	it("keeps the open project when another folder is removed", () => {
		expect(
			selectedProjectIdAfterDelete({
				projects,
				selectedProjectId: "b",
				deletedProjectId: "a",
			}),
		).toBe("b");
	});

	it("opens the next remaining project when the open folder is removed", () => {
		expect(
			selectedProjectIdAfterDelete({
				projects,
				selectedProjectId: "a",
				deletedProjectId: "a",
			}),
		).toBe("b");
	});

	it("clears selection when the last project is removed", () => {
		expect(
			selectedProjectIdAfterDelete({
				projects: [{ id: "a" }],
				selectedProjectId: "a",
				deletedProjectId: "a",
			}),
		).toBeUndefined();
	});
});

describe("projectMachineRefsToDestroy", () => {
	it("includes the template and unique session VMs", () => {
		expect(
			projectMachineRefsToDestroy({
				sessionProviderRefs: ["vm-agent", "vm-template", "vm-side", null],
				templateProviderRef: "vm-template",
			}).sort(),
		).toEqual(["vm-agent", "vm-side", "vm-template"]);
	});

	it("returns nothing when the project never started machines", () => {
		expect(
			projectMachineRefsToDestroy({
				sessionProviderRefs: [null, undefined],
				templateProviderRef: null,
			}),
		).toEqual([]);
	});
});
