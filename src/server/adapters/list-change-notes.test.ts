import { beforeEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({ notes: [] as [string, readonly string[]][] }));
const db = vi.hoisted(() => ({
	rows: [] as Record<string, unknown>[],
	rowCount: 1,
}));
vi.mock("./user-hub-notes", () => ({
	noteUserHub: (userId: string, topics: readonly string[]) => {
		hub.notes.push([userId, topics]);
	},
}));
vi.mock("./database", () => ({
	database: () => ({
		query: async () => ({ rows: db.rows, rowCount: db.rowCount }),
	}),
}));

import { releaseAgentTaskStart, reserveAgentTaskStart } from "./agent-capacity";
import {
	insertAgentSession,
	titleUntitledAgentSession,
} from "./agent-sessions";
import { setChatArchived, setProjectArchived } from "./archive";
import {
	listChangeTopics,
	noteProjectsChanged,
	noteSessionsChanged,
} from "./list-change-notes";
import { deleteProjectForOwner, saveProject } from "./projects";
import { setProjectYMode } from "./y-mode";

beforeEach(() => {
	hub.notes.length = 0;
	db.rows = [{ id: "x" }];
	db.rowCount = 1;
});

describe("list change topics", () => {
	it("a chat change names its project when known, else every list", () => {
		expect(listChangeTopics.sessions("p1")).toEqual(["sessions:p1"]);
		expect(listChangeTopics.sessions(undefined)).toEqual(["sessions"]);
	});
	it("a project change also moves the chat lists", () => {
		expect(listChangeTopics.projects()).toEqual(["projects", "sessions"]);
	});
	it("tells the user's hub once per call", () => {
		noteSessionsChanged("u1", "p1");
		noteProjectsChanged("u1");
		expect(hub.notes).toEqual([
			["u1", ["sessions:p1"]],
			["u1", ["projects", "sessions"]],
		]);
	});
});

describe("write paths tell the hub", () => {
	it("archiving a chat", async () => {
		await setChatArchived("u1", "s1", true);
		expect(hub.notes).toEqual([["u1", ["sessions"]]]);
	});
	it("archiving a project", async () => {
		await setProjectArchived("u1", "p1", true);
		expect(hub.notes).toEqual([["u1", ["projects", "sessions"]]]);
	});
	it("adding a project", async () => {
		db.rows = [{ id: "p1" }];
		await saveProject(
			"u1",
			{ repositoryId: 1, installationId: 2, fullName: "a/b" } as never,
			"main",
		);
		expect(hub.notes).toEqual([["u1", ["projects", "sessions"]]]);
	});
	it("deleting a project", async () => {
		await deleteProjectForOwner("u1", "p1");
		expect(hub.notes).toEqual([["u1", ["projects", "sessions"]]]);
	});
	it("a failed write tells nobody", async () => {
		db.rows = [];
		await setChatArchived("u1", "s1", true);
		expect(hub.notes).toEqual([]);
	});
});

describe("thread paths tell the hub", () => {
	const sessionRow = {
		id: "s1",
		user_id: "u1",
		project_id: "p1",
		harness: "api",
		items: [],
		created_at: new Date(),
		updated_at: new Date(),
	};
	it("a thread created by anyone (a person, another session, Y²) joins the project's list", async () => {
		db.rows = [sessionRow];
		await insertAgentSession({
			userId: "u1",
			projectId: "p1",
			workspaceId: "w1",
			harness: "api",
		} as never);
		expect(hub.notes).toContainEqual(["u1", ["sessions:p1"]]);
	});
	it("a rename", async () => {
		await titleUntitledAgentSession("u1", "s1", "Fix the build");
		expect(hub.notes).toEqual([["u1", ["sessions"]]]);
	});
	it("a helper thread starting, and a failed start handed back", async () => {
		db.rows = [{ id: "t1", parent_session_id: "root" }];
		await reserveAgentTaskStart("u1", "p1", "t1");
		await releaseAgentTaskStart("u1", "p1", "t1");
		expect(
			hub.notes.filter(([, topics]) => topics[0] === "sessions:p1"),
		).toHaveLength(2);
	});
	it("Y² on or off for a project", async () => {
		await setProjectYMode("u1", "p1", true);
		expect(hub.notes).toEqual([["u1", ["projects", "sessions"]]]);
	});
});
