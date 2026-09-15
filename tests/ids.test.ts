import { expect, it } from "vitest";
import { JobId, ProjectId, UserId, WorkspaceId } from "../src/domain/ids";

it("rejects empty branded identifiers", () => {
	expect(() => UserId(" ")).toThrow("UserId");
	expect(() => ProjectId("")).toThrow("ProjectId");
	expect(() => WorkspaceId("")).toThrow("WorkspaceId");
	expect(() => JobId("")).toThrow("JobId");
});
