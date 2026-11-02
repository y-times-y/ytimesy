import { describe, expect, it } from "vitest";
import { initialSetupMessageId } from "./environment-setup";
import { startsProjectSetup } from "./project-setup-start";

const building = { projectId: "p1", status: "cloning", build: null };

describe("startsProjectSetup", () => {
	it("starts a new project's setup while its first build runs and it has no chat", () => {
		for (const status of ["queued", "provisioning", "cloning", "installing"])
			expect(
				startsProjectSetup({
					projectId: "p1",
					workspace: { ...building, status },
					chats: [],
					startedInThisTab: new Set(),
				}),
			).toBe(true);
	});

	it("never starts it twice, nor for a project that has a chat or a working environment", () => {
		const base = {
			projectId: "p1",
			workspace: building,
			chats: [],
			startedInThisTab: new Set<string>(),
		};
		expect(
			startsProjectSetup({ ...base, startedInThisTab: new Set(["p1"]) }),
		).toBe(false);
		expect(startsProjectSetup({ ...base, chats: [{ id: "c1" }] })).toBe(false);
		// Chats still loading: not yet known to have none.
		expect(startsProjectSetup({ ...base, chats: undefined })).toBe(false);
		for (const status of ["ready", "failed"])
			expect(
				startsProjectSetup({ ...base, workspace: { ...building, status } }),
			).toBe(false);
		// A rebuild keeps the working environment: never blocked, never restarted.
		expect(
			startsProjectSetup({
				...base,
				workspace: { ...building, build: { rebuild: true } },
			}),
		).toBe(false);
		// Another project's status says nothing about this one.
		expect(
			startsProjectSetup({
				...base,
				workspace: { ...building, projectId: "p2" },
			}),
		).toBe(false);
	});
});

describe("initialSetupMessageId", () => {
	it("is one UUID per project, the same in every tab", () => {
		const id = initialSetupMessageId("6f0c8a3e-1b2d-4c5e-8f90-123456789abc");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(initialSetupMessageId("6f0c8a3e-1b2d-4c5e-8f90-123456789abc")).toBe(
			id,
		);
		expect(initialSetupMessageId("another-project")).not.toBe(id);
	});
});
