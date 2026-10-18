import { describe, expect, it, vi } from "vitest";
import type { EvidenceGitApi } from "../adapters/github/pr-evidence-refs";
import { evidenceUserLabelFor } from "./pr-evidence";
import {
	expirePullRequestEvidence,
	removeUserPullRequestEvidence,
} from "./pr-evidence-cleanup";

vi.mock("../adapters/dev-eval-users", () => ({
	harnessVariantForUser: vi.fn(),
	prEvidenceEvalUserIds: vi.fn(async () => []),
}));
vi.mock("../adapters/projects", () => ({ listProjects: vi.fn() }));

function repository(refs: Map<string, string>, open: number[] = []) {
	return {
		createBlob: vi.fn(),
		createTree: vi.fn(),
		createCommit: vi.fn(),
		setRef: vi.fn(),
		deleteRef: vi.fn(async (ref: string) => {
			refs.delete(`refs/${ref}`);
		}),
		listRefs: vi.fn(async (prefix: string) =>
			[...refs]
				.filter(([ref]) => ref.startsWith(`refs/${prefix}`))
				.map(([ref, sha]) => ({ ref, sha })),
		),
		commitDate: vi.fn(async () => new Date().toISOString()),
		openPullNumbers: vi.fn(async () => new Set(open)),
	} satisfies EvidenceGitApi;
}

const label = evidenceUserLabelFor("alice");

describe("removing a user's evidence", () => {
	it("deletes the user's refs from each repository once, and reports unreachable ones", async () => {
		const refs = new Map([
			[`refs/ytimesy/evidence/${label}/pr-1`, "a".repeat(40)],
			[
				`refs/ytimesy/evidence/${evidenceUserLabelFor("bob")}/pr-1`,
				"a".repeat(40),
			],
		]);
		const git = vi.fn(async (_id: number | string, fullName: string) => {
			if (fullName === "owner/gone") throw new Error("404");
			return repository(refs);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const result = await removeUserPullRequestEvidence(
			"alice",
			[
				{ fullName: "owner/app", installationId: 2 },
				{ fullName: "Owner/App", installationId: 2 },
				{ fullName: "owner/gone", installationId: 2 },
			],
			{ git, enabled: async () => true },
		);
		warn.mockRestore();
		expect(result).toEqual({ removed: 1, failed: ["owner/gone"] });
		expect(git).toHaveBeenCalledTimes(2);
		expect(refs.size).toBe(1);
	});

	it("makes no GitHub calls for users who never had evidence on", async () => {
		const git = vi.fn();
		expect(
			await removeUserPullRequestEvidence(
				"alice",
				[{ fullName: "owner/app", installationId: 2 }],
				{ git, enabled: async () => false },
			),
		).toEqual({ removed: 0, failed: [] });
		expect(git).not.toHaveBeenCalled();
	});
});

describe("the expiry sweep", () => {
	it("removes refs of closed pull requests for every user with evidence on", async () => {
		const refs = new Map([
			[`refs/ytimesy/evidence/${label}/pr-1`, "a".repeat(40)],
			[`refs/ytimesy/evidence/${label}/pr-2`, "a".repeat(40)],
		]);
		const removed = await expirePullRequestEvidence({
			users: async () => ["alice"],
			repositories: async () => [{ fullName: "owner/app", installationId: 2 }],
			git: async () => repository(refs, [2]),
		});
		expect(removed).toBe(1);
		expect([...refs.keys()]).toEqual([`refs/ytimesy/evidence/${label}/pr-2`]);
	});
});
