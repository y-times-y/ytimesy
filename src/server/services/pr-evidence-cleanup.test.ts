import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type EvidenceStore,
	evidenceCapturePrefix,
	evidenceObjectKey,
} from "../adapters/pr-evidence-store";
import {
	expirePullRequestEvidence,
	removeProjectPullRequestEvidence,
	removeUserPullRequestEvidence,
} from "./pr-evidence-cleanup";

const projectA = "0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const projectB = "1f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f";
const capture = (n: number) => `a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5${n}`;

type Row = {
	id: string;
	userId: string;
	projectId: string;
	fullName: string;
	pullNumber: number;
	expired: boolean;
};

let objects: Set<string>;
let rows: Row[];
let store: EvidenceStore;

function seed(row: Row) {
	rows.push(row);
	for (const name of ["01-home.png", "recording.webm"])
		objects.add(evidenceObjectKey(row, row.id, name));
}

const fakeRows = () => ({
	ofOwner: vi.fn(async (userId: string, projectId?: string) =>
		rows.filter(
			(row) =>
				row.userId === userId && (!projectId || row.projectId === projectId),
		),
	),
	expired: vi.fn(async () => rows.filter((row) => row.expired)),
	repositories: vi.fn(async () => [
		...new Map(
			rows.map((row) => [
				row.fullName,
				{ installationId: 2, fullName: row.fullName },
			]),
		).values(),
	]),
	ofClosedPulls: vi.fn(
		async (repo: { fullName: string }, open: ReadonlySet<number>) =>
			rows.filter(
				(row) => row.fullName === repo.fullName && !open.has(row.pullNumber),
			),
	),
	failStale: vi.fn(async () => 0),
	remove: vi.fn(async (ids: readonly string[]) => {
		rows = rows.filter((row) => !ids.includes(row.id));
		return ids.length;
	}),
});

beforeEach(() => {
	objects = new Set();
	rows = [];
	store = {
		put: vi.fn(),
		get: vi.fn(),
		removePrefix: vi.fn(async (prefix: string) => {
			let removed = 0;
			for (const key of [...objects])
				if (key.startsWith(prefix)) {
					objects.delete(key);
					removed++;
				}
			return removed;
		}),
	};
	const base = { fullName: "owner/app", pullNumber: 7, expired: false };
	seed({ ...base, id: capture(1), userId: "alice", projectId: projectA });
	seed({ ...base, id: capture(2), userId: "alice", projectId: projectB });
	seed({ ...base, id: capture(3), userId: "bob", projectId: projectA });
});

describe("deleting evidence with its project or account", () => {
	it("removes one project's media and rows and nothing of other projects or users", async () => {
		const deps = { store, rows: fakeRows() };
		expect(
			await removeProjectPullRequestEvidence("alice", projectA, deps),
		).toBe(1);
		expect(rows.map((row) => row.id)).toEqual([capture(2), capture(3)]);
		expect(
			[...objects].some((key) =>
				key.startsWith(
					evidenceCapturePrefix(
						{ userId: "alice", projectId: projectA },
						capture(1),
					),
				),
			),
		).toBe(false);
		expect(objects.size).toBe(4);
	});

	it("removes everything a user stored on account deletion", async () => {
		const deps = { store, rows: fakeRows() };
		expect(await removeUserPullRequestEvidence("alice", deps)).toBe(2);
		expect(rows.map((row) => row.userId)).toEqual(["bob"]);
		expect(objects.size).toBe(2);
	});

	it("stops before deleting rows when media cannot be removed", async () => {
		const failing = {
			...store,
			removePrefix: vi.fn(async () => {
				throw new Error("R2 listing failed.");
			}),
		};
		const deps = { store: failing, rows: fakeRows() };
		await expect(removeUserPullRequestEvidence("alice", deps)).rejects.toThrow(
			"R2 listing failed",
		);
		expect(rows).toHaveLength(3);
	});
});

describe("the evidence-expiry sweep", () => {
	it("removes expired captures and captures of pull requests that are no longer open", async () => {
		rows[0].expired = true;
		seed({
			id: capture(4),
			userId: "bob",
			projectId: projectB,
			fullName: "owner/other",
			pullNumber: 3,
			expired: false,
		});
		const deps = {
			store,
			rows: fakeRows(),
			openPulls: vi.fn(async (_installation: number | string, name: string) =>
				name === "owner/app" ? new Set([7]) : new Set<number>(),
			),
		};
		expect(await expirePullRequestEvidence(deps)).toBe(2);
		expect(rows.map((row) => row.id)).toEqual([capture(2), capture(3)]);
		expect(objects.size).toBe(4);
		expect(deps.rows.failStale).toHaveBeenCalled();
	});

	it("keeps a repository's evidence when its pull requests cannot be read", async () => {
		const deps = {
			store,
			rows: fakeRows(),
			openPulls: vi.fn(async () => {
				throw new Error("installation removed");
			}),
		};
		expect(await expirePullRequestEvidence(deps)).toBe(0);
		expect(rows).toHaveLength(3);
	});

	it("keeps a row whose media could not be removed, for the next sweep", async () => {
		rows[0].expired = true;
		const deps = {
			store: {
				...store,
				removePrefix: vi.fn(async () => {
					throw new Error("R2 delete failed (500).");
				}),
			},
			rows: fakeRows(),
			openPulls: vi.fn(async () => new Set([7])),
		};
		expect(await expirePullRequestEvidence(deps)).toBe(0);
		expect(rows).toHaveLength(3);
	});
});
