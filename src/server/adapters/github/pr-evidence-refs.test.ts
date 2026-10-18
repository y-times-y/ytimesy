import { describe, expect, it, vi } from "vitest";
import {
	deleteUserEvidenceRefs,
	type EvidenceGitApi,
	pruneEvidenceRefs,
	publishEvidenceCommit,
} from "./pr-evidence-refs";

const me = "u-0123456789abcdef";
const other = "u-ffffffffffffffff";
const day = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-18T12:00:00Z");

function repository(open: number[], dates: Record<string, string> = {}) {
	const refs = new Map<string, string>();
	let commits = 0;
	const api: EvidenceGitApi = {
		createBlob: vi.fn(async () => "blob"),
		createTree: vi.fn(async () => "tree"),
		createCommit: vi.fn(async (_tree, _message, date) => {
			const sha = `c${++commits}`.padEnd(40, "0");
			dates[sha] = date;
			return sha;
		}),
		setRef: vi.fn(async (ref, sha) => {
			refs.set(`refs/${ref}`, sha);
		}),
		deleteRef: vi.fn(async (ref) => {
			refs.delete(`refs/${ref}`);
		}),
		listRefs: vi.fn(async (prefix) =>
			[...refs]
				.filter(([ref]) => ref.startsWith(`refs/${prefix}`))
				.map(([ref, sha]) => ({ ref, sha })),
		),
		commitDate: vi.fn(async (sha) => dates[sha] ?? null),
		openPullNumbers: vi.fn(async () => new Set(open)),
	};
	return { api, refs, dates };
}

describe("evidence refs in the pull request's repository", () => {
	it("stores one parentless commit per pull request under a hidden ref and replaces it", async () => {
		const repo = repository([7]);
		const first = await publishEvidenceCommit(repo.api, {
			userLabel: me,
			pullNumber: 7,
			files: [{ name: "01-home.png", data: Buffer.from("a") }],
			message: "evidence",
			now,
		});
		const second = await publishEvidenceCommit(repo.api, {
			userLabel: me,
			pullNumber: 7,
			files: [{ name: "01-home.png", data: Buffer.from("b") }],
			message: "evidence",
			now,
		});
		expect(first).not.toBe(second);
		expect([...repo.refs]).toEqual([
			[`refs/ytimesy/evidence/${me}/pr-7`, second],
		]);
		expect(vi.mocked(repo.api.createCommit).mock.calls[0][1]).toContain(
			"[skip ci]",
		);
	});

	it("refuses file names the capture never produces", async () => {
		const repo = repository([7]);
		await expect(
			publishEvidenceCommit(repo.api, {
				userLabel: me,
				pullNumber: 7,
				files: [{ name: "../.github/workflows/x.yml", data: Buffer.from("") }],
				message: "evidence",
			}),
		).rejects.toThrow("Refusing");
		expect(repo.api.createTree).not.toHaveBeenCalled();
	});

	it("expires closed pull requests and old captures, and leaves other users alone", async () => {
		const repo = repository([1, 2]);
		const fresh = "f".repeat(40);
		const old = "0".repeat(40);
		repo.dates[fresh] = new Date(now.getTime() - day).toISOString();
		repo.dates[old] = new Date(now.getTime() - 31 * day).toISOString();
		repo.refs.set(`refs/ytimesy/evidence/${me}/pr-1`, fresh);
		repo.refs.set(`refs/ytimesy/evidence/${me}/pr-2`, old);
		repo.refs.set(`refs/ytimesy/evidence/${me}/pr-3`, fresh);
		repo.refs.set(`refs/ytimesy/evidence/${other}/pr-3`, fresh);
		const removed = await pruneEvidenceRefs(repo.api, me, { now });
		expect(removed.sort()).toEqual([
			`refs/ytimesy/evidence/${me}/pr-2`,
			`refs/ytimesy/evidence/${me}/pr-3`,
		]);
		expect([...repo.refs.keys()].sort()).toEqual([
			`refs/ytimesy/evidence/${me}/pr-1`,
			`refs/ytimesy/evidence/${other}/pr-3`,
		]);
	});

	it("deletes every evidence ref of one user", async () => {
		const repo = repository([]);
		repo.refs.set(`refs/ytimesy/evidence/${me}/pr-1`, "a".repeat(40));
		repo.refs.set(`refs/ytimesy/evidence/${me}/pr-9`, "a".repeat(40));
		repo.refs.set(`refs/ytimesy/evidence/${other}/pr-1`, "a".repeat(40));
		expect(await deleteUserEvidenceRefs(repo.api, me)).toBe(2);
		expect([...repo.refs.keys()]).toEqual([
			`refs/ytimesy/evidence/${other}/pr-1`,
		]);
	});
});
