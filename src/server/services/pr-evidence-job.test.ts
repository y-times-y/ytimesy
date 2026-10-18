import { beforeEach, describe, expect, it, vi } from "vitest";
import { backgroundJob } from "#/domain/background-job";

const deps = vi.hoisted(() => ({
	session: vi.fn(),
	project: vi.fn(),
	attach: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: deps.session,
}));
vi.mock("../adapters/projects", () => ({ projectForOwner: deps.project }));
vi.mock("./pr-evidence", () => ({
	attachPullRequestEvidence: deps.attach,
	pullRequestEvidenceEnabled: vi.fn(async () => false),
}));

import {
	queuePullRequestEvidence,
	runPullRequestEvidenceJob,
} from "./pr-evidence-job";
import type { WorkspaceMachines } from "./workspace-machines";

const job = {
	userId: "alice",
	sessionId: "chat-1",
	revision: `refs/ytimesy/turn-commits/${"a".repeat(64)}`,
	installationId: 2,
	fullName: "owner/app",
	pullNumber: 7,
};

const machines = {
	ensureRunning: vi.fn(async () => undefined),
	exec: vi.fn(),
	writeTextFile: vi.fn(),
	readTextFile: vi.fn(),
} as unknown as WorkspaceMachines;

beforeEach(() => {
	vi.clearAllMocks();
	deps.project.mockResolvedValue({
		id: "p1",
		fullName: "owner/app",
		installationId: 2,
		repositoryId: 1,
		branch: "main",
	});
	deps.attach.mockResolvedValue({
		kind: "updated",
		status: "captured",
		evidenceId: "e1",
	});
});

describe("queueing evidence at the handoff", () => {
	it("dispatches one background job and returns without capturing", async () => {
		const dispatch = vi.fn(async () => true);
		expect(
			await queuePullRequestEvidence(job, {
				enabled: async () => true,
				dispatch,
			}),
		).toBe(true);
		const queued = dispatch.mock.calls[0] as unknown[];
		expect(backgroundJob.parse(queued[0])).toMatchObject({
			kind: "pr-evidence",
			...job,
		});
		expect(deps.attach).not.toHaveBeenCalled();
	});

	it("queues nothing with prEvidence off", async () => {
		const dispatch = vi.fn(async () => true);
		expect(
			await queuePullRequestEvidence(job, {
				enabled: async () => false,
				dispatch,
			}),
		).toBe(false);
		expect(dispatch).not.toHaveBeenCalled();
	});
});

describe("the background capture", () => {
	it("waits for the turn to be reported complete, then captures in the chat's workspace", async () => {
		deps.session
			.mockResolvedValueOnce({
				id: "chat-1",
				turnStatus: "running",
				providerRef: "vm",
				projectId: "p1",
			})
			.mockResolvedValue({
				id: "chat-1",
				turnStatus: "idle",
				providerRef: "vm",
				projectId: "p1",
			});
		const sleep = vi.fn(async () => undefined);
		await runPullRequestEvidenceJob(machines, job, { sleep });
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(machines.ensureRunning).toHaveBeenCalledWith("vm");
		expect(deps.attach.mock.calls[0][0]).toMatchObject({
			userId: "alice",
			projectId: "p1",
			sessionId: "chat-1",
			providerRef: "vm",
			directory: "/home/ubuntu/app",
			revision: job.revision,
			pullNumber: 7,
		});
	});

	it("does nothing for a repository that is no longer in the chat's project", async () => {
		deps.session.mockResolvedValue({
			id: "chat-1",
			turnStatus: "idle",
			providerRef: "vm",
			projectId: "p1",
		});
		expect(
			await runPullRequestEvidenceJob(
				machines,
				{ ...job, fullName: "owner/other" },
				{ sleep: async () => undefined },
			),
		).toEqual({ kind: "unavailable" });
		expect(machines.ensureRunning).not.toHaveBeenCalled();
		expect(deps.attach).not.toHaveBeenCalled();
	});
});
