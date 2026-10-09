import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import {
	closeProductionEvaluation,
	exportReviewedEvaluationPatches,
	openProductionEvaluation,
	productionEvaluationSnapshot,
	submitProductionEvaluation,
} from "../benchmarks/evaluation/production";
import type { EvaluationProtocol } from "../src/domain/harness-evaluation";
import type { WorkspaceMachines } from "../src/server/services/workspace-machines";

const mocks = vi.hoisted(() => ({
	query: vi.fn(),
	owner: vi.fn(),
	children: vi.fn(),
	project: vi.fn(),
	open: vi.fn(),
	bind: vi.fn(),
	remove: vi.fn(),
	cancel: vi.fn(),
	send: vi.fn(),
	evidence: vi.fn(),
	patch: vi.fn(),
}));
vi.mock("../src/server/adapters/task-patch-evidence", () => ({
	taskPatchEvidence: mocks.evidence,
}));
vi.mock("../src/server/services/reviewed-task-import", () => ({
	captureTaskPatch: mocks.patch,
}));
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query: mocks.query }),
}));
vi.mock("../src/server/adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.owner,
	descendantAgentSessions: mocks.children,
}));
vi.mock("../src/server/adapters/projects", () => ({
	projectForOwner: mocks.project,
}));
vi.mock("../src/server/services/agent-session-machine", () => ({
	openAgentSession: mocks.open,
	bindAgentSessionMachine: mocks.bind,
	deleteAgentSessionMachine: mocks.remove,
}));
vi.mock("../src/server/services/cancel-server-turn", () => ({
	cancelServerTurn: mocks.cancel,
}));
vi.mock("../src/server/services/harness-workspace-session", () => ({
	sendHarnessWorkspaceTask: mocks.send,
}));

const root = {
	id: "11111111-1111-4111-8111-111111111111",
	providerRef: "root-vm",
	turnStatus: "completed",
};
const child = {
	id: "22222222-2222-4222-8222-222222222222",
	providerRef: "builder-vm",
	turnStatus: "completed",
	taskState: "done",
	taskAccess: "read_write",
	taskReviewState: "reviewed",
};
const protocol: EvaluationProtocol = {
	version: 1,
	phase: "development",
	baseline: "a".repeat(40),
	modelId: "model",
	reasoning: "medium",
	seed: 0,
	repetitions: 1,
	graderImage: `node@sha256:${"a".repeat(64)}`,
	limits: { durationSeconds: 60, modelRequests: 5, tokens: 10000 },
	tasks: [
		{
			id: "task",
			benchmark: "development",
			datasetRevision: "b".repeat(40),
			projectId: root.id,
			repository: "owner/repo",
			branch: "main",
			commit: "c".repeat(40),
			prompt: "Fix parser",
			allowedPaths: ["parser.ts"],
			verifier: {
				command: ["/protected/verifier", "node"],
				sha256: "d".repeat(64),
			},
		},
	],
};
const task = protocol.tasks[0];
const exec = vi.fn();
const machines = { exec } as unknown as WorkspaceMachines;
const attempt = {
	rootId: root.id,
	runId: "run",
	projectId: root.id,
	vmId: root.providerRef,
};
const completionBaseline = {
	base: task.commit,
	tree: "a".repeat(40),
	patchSha256: "b".repeat(64),
	changed: false,
	policyChanged: false,
	recipe: JSON.stringify({ checks: ["npm test"] }),
	manifest: null,
	files: [],
};
beforeEach(() => {
	vi.clearAllMocks();
	exec.mockReset();
	vi.stubEnv("YTIMESY_HARNESS_EVALUATION_ENABLED", "1");
	mocks.project.mockResolvedValue({ id: root.id, fullName: "owner/repo" });
	mocks.open.mockResolvedValue(root);
	mocks.owner.mockResolvedValue(root);
	mocks.children.mockResolvedValue([child]);
	mocks.query.mockResolvedValue({ rows: [{ count: "0", id: "run" }] });
	mocks.evidence.mockResolvedValue({
		reviews: new Map([
			[
				child.id,
				{ taskId: child.id, base: task.commit, sha256: "a".repeat(64) },
			],
		]),
		imports: [],
	});
	mocks.patch.mockResolvedValue({
		base: task.commit,
		sha256: "a".repeat(64),
		bytes: Buffer.from("verified patch"),
	});
	exec.mockImplementation(async (_vm, command: string) => ({
		exitCode: 0,
		stdout: command.includes("symbolic-ref")
			? "evaluation-frozen"
			: command.includes("Saved baseline differs")
				? JSON.stringify(completionBaseline)
				: task.commit,
		stderr: "",
	}));
	mocks.send.mockReturnValue(
		Effect.succeed({ connection: { status: "connected" } }),
	);
});

it("rejects missing completion policy before registering or submitting paid inference", async () => {
	exec.mockResolvedValueOnce({ exitCode: 0, stdout: task.commit, stderr: "" });
	exec.mockResolvedValueOnce({
		exitCode: 0,
		stdout: "evaluation-frozen",
		stderr: "",
	});
	exec.mockResolvedValueOnce({
		exitCode: 0,
		stdout: JSON.stringify({ ...completionBaseline, recipe: null }),
		stderr: "",
	});
	await expect(
		openProductionEvaluation(machines, "alice", task, protocol),
	).rejects.toThrow("Configure project verification checks");
	expect(
		mocks.query.mock.calls.some(([sql]) =>
			sql.includes("insert into harness_evaluation_run"),
		),
	).toBe(false);
	expect(mocks.send).not.toHaveBeenCalled();
	expect(mocks.remove).toHaveBeenCalled();
});

it("uses normal production submission with the frozen prompt, model and reasoning", async () => {
	await openProductionEvaluation(machines, "alice", task, protocol);
	expect(mocks.query).toHaveBeenCalledWith(
		expect.stringContaining(
			"selected_branch=$3,working_branch=$3,base_branch=$4",
		),
		[root.id, "alice", "evaluation-frozen", task.branch],
	);
	await submitProductionEvaluation(machines, "alice", attempt, task, protocol);
	expect(mocks.send).toHaveBeenCalledWith(
		machines,
		expect.objectContaining({ sessionId: root.id, harnessId: "codex" }),
		{ text: task.prompt, modelId: "model", variant: "medium", fast: false },
	);
});

it("rejects detached snapshots before registering a billable run", async () => {
	exec.mockResolvedValueOnce({ exitCode: 0, stdout: task.commit, stderr: "" });
	exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "detached" });
	await expect(
		openProductionEvaluation(machines, "alice", task, protocol),
	).rejects.toThrow("valid local branch");
	expect(mocks.query).not.toHaveBeenCalled();
	expect(mocks.remove).toHaveBeenCalled();
});

it("cleans up only its new chat when the checkout is dirty or unpinned", async () => {
	exec.mockResolvedValue({
		exitCode: 0,
		stdout: `${task.commit}\n M parser.ts`,
		stderr: "",
	});
	await expect(
		openProductionEvaluation(machines, "alice", task, protocol),
	).rejects.toThrow("dirty");
	expect(mocks.remove).toHaveBeenCalledWith(machines, {
		userId: "alice",
		projectId: root.id,
		sessionId: root.id,
	});
});

it("waits for child work and completion delivery rather than the first root final", async () => {
	mocks.children.mockResolvedValue([
		{ ...child, taskState: "working", turnStatus: "running" },
	]);
	expect((await productionEvaluationSnapshot("alice", root.id)).settled).toBe(
		false,
	);
	mocks.children.mockResolvedValue([child]);
	mocks.query
		.mockResolvedValueOnce({ rows: [{ count: "0" }] })
		.mockResolvedValueOnce({ rows: [{ count: "1" }] });
	expect((await productionEvaluationSnapshot("alice", root.id)).settled).toBe(
		false,
	);
	expect((await productionEvaluationSnapshot("alice", root.id)).settled).toBe(
		true,
	);
});

it("exports only reviewed builders on distinct execution VMs", async () => {
	mocks.children.mockResolvedValue([{ ...child, taskReviewState: "pending" }]);
	await expect(
		exportReviewedEvaluationPatches(machines, "alice", root.id, task.commit),
	).rejects.toThrow("reviewed");
	mocks.children.mockResolvedValue([
		{ ...child, providerRef: root.providerRef },
	]);
	await expect(
		exportReviewedEvaluationPatches(machines, "alice", root.id, task.commit),
	).rejects.toThrow("isolated");
	mocks.children.mockResolvedValue([child]);
	expect(
		await exportReviewedEvaluationPatches(
			machines,
			"alice",
			root.id,
			task.commit,
		),
	).toHaveLength(1);
});

it("closes admission before cancelling and deleting the disposable tree", async () => {
	await closeProductionEvaluation(machines, "alice", attempt);
	expect(mocks.query.mock.calls[0][0]).toContain("state='stopped'");
	expect(mocks.cancel.mock.calls).toEqual([
		["alice", root.id],
		["alice", child.id],
	]);
	expect(mocks.query.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.cancel.mock.invocationCallOrder[0],
	);
	expect(mocks.cancel.mock.invocationCallOrder[1]).toBeLessThan(
		mocks.remove.mock.invocationCallOrder[0],
	);
});

it("rejects final checkout edits after acceptance", async () => {
	mocks.patch.mockResolvedValue({
		base: task.commit,
		sha256: "b".repeat(64),
		bytes: Buffer.from("changed after review"),
	});
	await expect(
		exportReviewedEvaluationPatches(machines, "alice", root.id, task.commit),
	).rejects.toThrow("accepted review");
});

it("exports one fully integrated reviewed checkout, not disconnected child patches", async () => {
	const sibling = {
		...child,
		id: "33333333-3333-4333-8333-333333333333",
		providerRef: "sibling-vm",
	};
	const integrated = {
		...child,
		id: "44444444-4444-4444-8444-444444444444",
		providerRef: "integrated-vm",
	};
	const reviews = new Map(
		[child, sibling, integrated].map((writer) => [
			writer.id,
			{ taskId: writer.id, base: task.commit, sha256: "a".repeat(64) },
		]),
	);
	const imported = (id: string) => ({
		taskId: id,
		destinationId: integrated.id,
		base: task.commit,
		sha256: "a".repeat(64),
	});
	mocks.children.mockResolvedValue([child, sibling, integrated]);
	mocks.evidence.mockResolvedValue({ reviews, imports: [imported(child.id)] });
	await expect(
		exportReviewedEvaluationPatches(machines, "alice", root.id, task.commit),
	).rejects.toThrow("every writable task");
	mocks.evidence.mockResolvedValue({
		reviews,
		imports: [imported(child.id), imported(sibling.id)],
	});
	mocks.patch.mockClear();
	expect(
		await exportReviewedEvaluationPatches(
			machines,
			"alice",
			root.id,
			task.commit,
		),
	).toEqual([{ taskId: integrated.id, patch: "verified patch" }]);
	expect(mocks.patch).toHaveBeenCalledOnce();
	expect(mocks.patch.mock.calls[0][1]).toBe("integrated-vm");
});
