import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { PUSH_CARD_LIFETIME_MS, type PushAnswer } from "#/domain/push-approval";
import type { SessionItem } from "#/domain/session-item";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import type { PushRequestRecord } from "../adapters/git-push-requests";
import {
	BRANCH_MOVED,
	cancelPushApproval,
	MAIN_MOVED,
	PUSH_APPROVAL_UNAVAILABLE,
	type PushApprovalDependencies,
	pushApprovalCardStatus,
	pushApprovedChange,
	pushFreshnessCommand,
	withPushResultNotices,
} from "./push-approval";

vi.mock("../adapters/database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

const chat = "6c4d0b51-1c6f-4e4b-8b62-3a8e7a2f9d22";
const requestId = "5b3c9a40-0b5e-4d3a-9a51-2f7d6f1e8c11";
const base = "a".repeat(40);
const commit = "b".repeat(40);
const now = Date.parse("2026-11-04T12:00:00Z");
const card: SessionItem = {
	kind: "pushApproval",
	id: SessionItemId("turn:card"),
	requestId,
	repo: "acme/app",
	branch: "main",
	commits: 2,
	summary: "Ship it",
};
const input = { userId: "alice", sessionId: chat, itemId: "turn:card" };

function harness(
	options: {
		request?: Partial<PushRequestRecord>;
		turnStatus?: AgentSessionRecord["turnStatus"];
		remote?: string | null;
		verdict?: string;
		newer?: boolean;
		branchAdvanced?: boolean;
		push?: () => Promise<void>;
	} = {},
) {
	const row: PushRequestRecord = {
		id: requestId,
		owner: "acme",
		name: "app",
		branch: "main",
		oldId: base,
		newId: commit,
		projectId: "00000000-0000-4000-8000-000000000001",
		sessionId: chat,
		createdAt: new Date(now - 60_000),
		requestedAt: new Date(now - 60_000),
		approvedAt: null,
		answer: null,
		answerDetail: null,
		noticed: false,
		...options.request,
	} as PushRequestRecord & { noticed: boolean };
	let items: SessionItem[] = [
		{ kind: "userMessage", id: SessionItemId("u"), text: "ship" },
		card,
	];
	const exec = vi.fn(async (_command: string, _timeout: number) => ({
		exitCode: 0,
		stdout: `${options.verdict ?? "fresh"}\n`,
		stderr: "",
	}));
	const state = row as PushRequestRecord & { noticed: boolean };
	const deps: PushApprovalDependencies = {
		requests: {
			record: vi.fn(async () => ({ ...state })),
			newerRefused: vi.fn(async () => options.newer ?? false),
			claimPush: vi.fn(async () => {
				if (state.approvedAt || state.answer) return false;
				state.approvedAt = new Date(now);
				return true;
			}),
			answer: vi.fn(
				async (
					_user: string,
					_id: string,
					answer: PushAnswer,
					detail: string,
				) => {
					if (state.answer) return false;
					state.answer = answer;
					state.answerDetail = detail;
					return true;
				},
			),
			claimUnnoticed: vi.fn(async () => {
				if (!state.answer || state.noticed) return [];
				state.noticed = true;
				return [{ ...state }];
			}),
			releaseNotice: vi.fn(async () => {
				state.noticed = false;
			}),
		},
		session: vi.fn(
			async () =>
				({
					id: chat,
					userId: "alice",
					items,
					providerRef: "vm-1",
					workingBranch: "ytimesy/chat",
					turnStatus: options.turnStatus ?? "completed",
				}) as unknown as AgentSessionRecord,
		),
		chatBranchAdvanced: vi.fn(async () => options.branchAdvanced ?? false),
		installation: vi.fn(async () => 11),
		remoteBranchSha: vi.fn(async () =>
			options.remote === undefined ? base : options.remote,
		),
		workspace: vi.fn(async () => ({
			directory: "/home/ubuntu/app",
			host: { exec, writeTextFile: vi.fn() },
		})),
		push: vi.fn(options.push ?? (async () => {})),
		replaceIdleItems: vi.fn(async (_u, _s, _expected, next) => {
			items = [...next];
			return true;
		}),
		now: () => now,
	};
	return { deps, state, exec, items: () => items };
}

describe("push approval card", () => {
	it("is pending while fresh, and checking it never pushes or starts a turn", async () => {
		const { deps } = harness();
		expect(await pushApprovalCardStatus(input, deps)).toEqual({
			answer: "pending",
		});
		expect(deps.push).not.toHaveBeenCalled();
		expect(deps.replaceIdleItems).not.toHaveBeenCalled();
	});

	it("shows Outdated after a later committing turn without waking the machine, still pending when nothing is newer", async () => {
		const fresh = harness();
		expect(await pushApprovalCardStatus(input, fresh.deps)).toEqual({
			answer: "pending",
		});
		expect(fresh.deps.chatBranchAdvanced).toHaveBeenCalledWith(
			11,
			expect.objectContaining({ newId: commit }),
			"ytimesy/chat",
		);
		const later = harness({ branchAdvanced: true });
		expect(await pushApprovalCardStatus(input, later.deps)).toEqual({
			answer: "outdated",
			detail: BRANCH_MOVED,
		});
		// Display never needs the machine: no workspace, no push, no command.
		for (const { deps, exec } of [fresh, later]) {
			expect(deps.workspace).not.toHaveBeenCalled();
			expect(deps.push).not.toHaveBeenCalled();
			expect(exec).not.toHaveBeenCalled();
		}
		// The settled answer stands on the next view and on Push.
		expect(await pushApprovedChange(input, later.deps)).toMatchObject({
			answer: "outdated",
		});
		expect(later.deps.push).not.toHaveBeenCalled();
	});

	it("expires after 24 hours unanswered, on view and on Push", async () => {
		const old = {
			requestedAt: new Date(now - PUSH_CARD_LIFETIME_MS - 1000),
		};
		const viewed = harness({ request: old });
		expect(await pushApprovalCardStatus(input, viewed.deps)).toMatchObject({
			answer: "expired",
		});
		const pushed = harness({ request: old });
		expect(await pushApprovedChange(input, pushed.deps)).toMatchObject({
			answer: "expired",
		});
		expect(pushed.deps.push).not.toHaveBeenCalled();
	});

	it("is outdated once main moved or the branch was pushed again, and is then never pushed", async () => {
		const moved = harness({ remote: "c".repeat(40) });
		expect(await pushApprovalCardStatus(input, moved.deps)).toEqual({
			answer: "outdated",
			detail: MAIN_MOVED("main"),
		});
		const newer = harness({ newer: true });
		expect(await pushApprovedChange(input, newer.deps)).toEqual({
			answer: "outdated",
			detail: BRANCH_MOVED,
		});
		expect(newer.deps.push).not.toHaveBeenCalled();
		// Settled: a later Push gets the same answer.
		expect(await pushApprovedChange(input, moved.deps)).toMatchObject({
			answer: "outdated",
		});
		expect(moved.deps.push).not.toHaveBeenCalled();
	});

	it("checks the workspace on Push: newer local commits or no fast-forward make it outdated", async () => {
		for (const [verdict, detail] of [
			["newer", BRANCH_MOVED],
			["diverged", MAIN_MOVED("main")],
		] as const) {
			const { deps, exec } = harness({ verdict });
			expect(await pushApprovedChange(input, deps)).toEqual({
				answer: "outdated",
				detail,
			});
			expect(exec.mock.calls[0][0]).toContain(
				`git merge-base --is-ancestor ${base} ${commit}`,
			);
			expect(deps.push).not.toHaveBeenCalled();
		}
		const missing = harness({ verdict: "missing" });
		expect(await pushApprovedChange(input, missing.deps)).toEqual({
			answer: "failed",
			detail: "the commit is no longer in the workspace",
		});
	});

	it("pushes exactly the approved commit to main server-side, then posts a notice without starting a turn", async () => {
		const { deps, items } = harness();
		expect(await pushApprovedChange(input, deps)).toEqual({
			answer: "pushed",
			detail: "bbbbbbb",
		});
		expect(deps.push).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				owner: "acme",
				name: "app",
				branch: "main",
				commit,
				installationId: 11,
				directory: "/home/ubuntu/app",
			}),
		);
		expect(items().at(-1)).toMatchObject({
			kind: "notice",
			id: `push-result:${requestId}`,
			message:
				"The user approved the push: bbbbbbb is now on main on acme/app.",
			pushResult: { requestId, answer: "pushed", detail: "bbbbbbb" },
		});
		// No user message: nothing starts a turn.
		expect(items().filter((item) => item.kind === "userMessage")).toHaveLength(
			1,
		);
		// A second click does not push again.
		expect(await pushApprovedChange(input, deps)).toMatchObject({
			answer: "pushed",
		});
		expect(deps.push).toHaveBeenCalledTimes(1);
	});

	it("says why when GitHub refuses, and nothing is pushed", async () => {
		let remote = base;
		const moved = harness({
			push: async () => {
				remote = "c".repeat(40);
				throw new Error("Workspace Git proxy transfer failed");
			},
		});
		moved.deps.remoteBranchSha = vi.fn(async () => remote);
		expect(await pushApprovedChange(input, moved.deps)).toEqual({
			answer: "outdated",
			detail: MAIN_MOVED("main"),
		});
		const refused = harness({
			push: async () => {
				throw new Error("Workspace Git proxy transfer failed");
			},
		});
		expect(await pushApprovedChange(input, refused.deps)).toEqual({
			answer: "failed",
			detail: "GitHub refused the push",
		});
	});

	it("starts one push only, and a click during it waits", async () => {
		const { deps, state } = harness();
		state.approvedAt = new Date(now - 1000);
		expect(await pushApprovedChange(input, deps)).toEqual({
			answer: "pending",
		});
		expect(await pushApprovalCardStatus(input, deps)).toEqual({
			answer: "pending",
		});
		expect(deps.push).not.toHaveBeenCalled();
	});

	it("cancels without pushing or starting a turn", async () => {
		const { deps, items } = harness();
		expect(await cancelPushApproval(input, deps)).toEqual({
			answer: "cancelled",
			detail: "",
		});
		expect(deps.push).not.toHaveBeenCalled();
		expect(items().at(-1)).toMatchObject({
			kind: "notice",
			pushResult: { answer: "cancelled" },
		});
	});

	it("leaves a running chat's notice to its turn, which tells the agent", async () => {
		const { deps, state } = harness({ turnStatus: "running" });
		await cancelPushApproval(input, deps);
		expect(deps.replaceIdleItems).not.toHaveBeenCalled();
		expect(state.noticed).toBe(false);
		const merged = await withPushResultNotices(
			{ userId: "alice", sessionId: chat, items: [card], messages: [] },
			deps.requests,
		);
		expect(merged?.items.at(-1)).toMatchObject({ kind: "notice" });
		expect(merged?.messages).toEqual([
			{
				role: "user",
				content:
					"The user cancelled the push to main on acme/app; leave the work on its branch or pull request.",
			},
		]);
		expect(
			await withPushResultNotices(
				{ userId: "alice", sessionId: chat, items: [card], messages: [] },
				deps.requests,
			),
		).toBeNull();
	});

	it("refuses a card from another chat or not in the transcript", async () => {
		const { deps } = harness({ request: { sessionId: "other" } });
		await expect(pushApprovalCardStatus(input, deps)).rejects.toThrow(
			PUSH_APPROVAL_UNAVAILABLE,
		);
		await expect(
			pushApprovedChange({ ...input, itemId: "missing" }, harness().deps),
		).rejects.toThrow(PUSH_APPROVAL_UNAVAILABLE);
	});
});

describe("pushFreshnessCommand on a real checkout", () => {
	it("tells fresh, newer local commits, diverged and missing apart", () => {
		const dir = mkdtempSync(join(tmpdir(), "ytimesy-push-fresh-"));
		try {
			const git = (...args: string[]) =>
				execFileSync(
					"git",
					["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
					{ encoding: "utf8" },
				).trim();
			git("init", "-q", "-b", "main");
			git("commit", "-q", "--allow-empty", "-m", "base");
			const mainSha = git("rev-parse", "HEAD");
			git("commit", "-q", "--allow-empty", "-m", "work");
			const approved = git("rev-parse", "HEAD");
			const verdict = (remote: string, target = approved) =>
				spawnSync(
					"sh",
					[
						"-c",
						pushFreshnessCommand({ directory: dir, commit: target, remote }),
					],
					{ encoding: "utf8" },
				).stdout.trim();
			expect(verdict(mainSha)).toBe("fresh");
			// A commit main never had: no fast-forward.
			git("checkout", "-q", "-b", "other", mainSha);
			git("commit", "-q", "--allow-empty", "-m", "elsewhere");
			const elsewhere = git("rev-parse", "HEAD");
			git("checkout", "-q", "main");
			expect(verdict(elsewhere)).toBe("diverged");
			git("commit", "-q", "--allow-empty", "-m", "more");
			expect(verdict(mainSha)).toBe("newer");
			expect(verdict(mainSha, "d".repeat(40))).toBe("missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
