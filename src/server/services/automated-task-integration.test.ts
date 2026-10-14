import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, it, vi } from "vitest";
import { WorkspaceId } from "#/domain/ids";
import { taskVerificationPlan } from "#/domain/task-integration-checks";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import type { WorkspaceMachines } from "./workspace-machines";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	save: vi.fn(),
	state: vi.fn(),
	event: vi.fn(),
	evidence: vi.fn(),
	prepare: vi.fn(),
	bind: vi.fn(),
	workspace: vi.fn(),
	stop: vi.fn(),
	capture: vi.fn(),
	import: vi.fn(),
	commit: vi.fn(),
	exec: vi.fn(),
	verify: vi.fn(),
	sourceEvidence: vi.fn(),
	batch: vi.fn(),
	completion: vi.fn(),
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: mocks.session,
	saveAgentSessionItems: mocks.save,
	saveAgentTaskState: mocks.state,
}));
vi.mock("../adapters/agent-task-events", () => ({
	saveAgentTaskResultAndEvent: mocks.event,
}));
vi.mock("../adapters/agent-task-command-receipts", () => ({
	readyBatchIntegration: mocks.batch,
}));
vi.mock("../adapters/task-patch-evidence", () => ({
	taskPatchEvidence: mocks.evidence,
}));
vi.mock("./agent-session-machine", () => ({
	prepareAgentTaskStart: mocks.prepare,
	bindPreparedAgentTaskMachine: mocks.bind,
}));
vi.mock("./api-turn-workspace", () => ({
	deferredApiTurnWorkspace: () => mocks.workspace,
}));
vi.mock("./api-command-scope", () => ({
	scopedShellCommand: (input: { command: string }) => input.command,
	stopApiTurnCommands: mocks.stop,
}));
vi.mock("./reviewed-task-import", async (importOriginal) => ({
	...(await importOriginal<typeof import("./reviewed-task-import")>()),
	captureTaskPatch: mocks.capture,
	importReviewedTaskChanges: mocks.import,
}));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
vi.mock("./turn-commit", () => ({ commitCompletedSessionTurn: mocks.commit }));
vi.mock("./completion-verification", () => ({
	verifyCompletedRepository: mocks.completion,
}));
vi.mock("./project-source-evidence", () => ({
	inspectProjectSourceEvidence: mocks.sourceEvidence,
}));
vi.mock("./agent-output-artifacts", () => ({
	agentOutputArtifacts: (input: { vm: string }) => ({
		recordVerification: mocks.verify,
		capture: async (command: string, seconds: number) => ({
			reference: "00000000-0000-4000-8000-000000000001",
			stopped: null,
			stdoutNextStart: null,
			stderrNextStart: null,
			...(await mocks.exec(input.vm, command, seconds * 1000)),
		}),
	}),
}));

import {
	baselineTaskVerificationCommand,
	integrateTaskDraft,
	stageReviewedBatchTask,
} from "./automated-task-integration";

it("reads the reviewed base in a real fresh checkout without a saved base ref", async () => {
	const run = promisify(execFile);
	const directory = await mkdtemp(
		join(tmpdir(), "ytimesy-integration-baseline-"),
	);
	try {
		await run("git", ["init", "-q", directory]);
		const manifest = JSON.stringify({ scripts: { test: "vitest run" } });
		await writeFile(join(directory, "package.json"), manifest);
		await run("git", ["-C", directory, "add", "."]);
		await run("git", [
			"-C",
			directory,
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.com",
			"commit",
			"-qm",
			"base",
		]);
		const base = (
			await run("git", ["-C", directory, "rev-parse", "HEAD"])
		).stdout.trim();
		await writeFile(
			join(directory, "package.json"),
			"untrusted working policy",
		);
		const result = await run("sh", [
			"-c",
			baselineTaskVerificationCommand(directory, base),
		]);
		expect(JSON.parse(result.stdout)).toMatchObject({
			recipe: null,
			manifest,
			files: ["package.json"],
		});
		await expect(
			run("sh", [
				"-c",
				baselineTaskVerificationCommand(directory, "a".repeat(40)),
			]),
		).rejects.toThrow();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

const parent = {
	id: "lead",
	userId: "owner",
	projectId: "project",
	parentSessionId: null,
} as AgentSessionRecord;
const draft = {
	...parent,
	id: "integration",
	parentSessionId: parent.id,
	taskState: "draft",
	taskAccess: "read_write",
	taskPlacement: "fresh",
	taskExecution: "parallel",
	providerRef: null,
} as AgentSessionRecord;
const sources = ["first", "second"].map((taskId) => ({
	taskId,
	sha256: "a".repeat(64),
	base: "b".repeat(40),
}));
const machines = { exec: mocks.exec } as unknown as WorkspaceMachines;
const workspace = { machines, vm: WorkspaceId("integration-vm"), cwd: "/repo" };
const control = () => ({
	signal: new AbortController().signal,
	turnId: "turn",
});

function stagedDestination() {
	return {
		...draft,
		providerRef: "integration-vm",
		taskState: "idle",
		items: [
			{
				kind: "userMessage",
				id: "older-turn:integration",
				text: "Original integration contract",
			},
			{
				kind: "dynamicToolCall",
				id: "stage",
				tool: "integration_stage",
				status: "completed",
				input: "{}",
				output: JSON.stringify({
					sha256: "c".repeat(64),
					base: sources[0].base,
					sources: [sources[0]],
				}),
			},
		],
	} as AgentSessionRecord;
}

it("stages the first reviewed patch while other siblings remain active, without checks or inference", async () => {
	const bound = {
		...draft,
		providerRef: "integration-vm",
		taskState: "working",
	};
	mocks.session.mockResolvedValueOnce(draft).mockResolvedValueOnce(bound);
	mocks.capture.mockResolvedValueOnce({
		sha256: "e".repeat(64),
		base: sources[0].base,
		bytes: Buffer.alloc(0),
	});
	expect(
		await stageReviewedBatchTask(machines, parent, sources[0], control()),
	).toMatchObject({
		taskId: draft.id,
		status: "staged",
		finalChecksStarted: false,
		sources: [sources[0]],
	});
	expect(mocks.import).toHaveBeenCalledOnce();
	expect(mocks.exec).not.toHaveBeenCalled();
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.state).toHaveBeenLastCalledWith(draft.id, "idle");
	expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				tool: "integration_stage",
				status: "completed",
			}),
		]),
	);
});

it("reuses the staged checkout, verifies its fingerprint and releases the occupied slot after each import", async () => {
	const idle = stagedDestination();
	mocks.session
		.mockResolvedValueOnce(idle)
		.mockResolvedValueOnce({ ...idle, taskState: "working" });
	mocks.prepare.mockResolvedValue({ task: idle, predecessor: null });
	expect(
		await stageReviewedBatchTask(machines, parent, sources[1], control()),
	).toMatchObject({ status: "staged", sources });
	expect(mocks.state).toHaveBeenLastCalledWith(draft.id, "idle");
	const saved = mocks.save.mock.calls.at(-1)?.[1];
	expect(saved[0].id).toBe("turn:integration");
});

it("rejects unrelated checkout changes before importing another patch", async () => {
	const idle = stagedDestination();
	mocks.session
		.mockResolvedValueOnce(idle)
		.mockResolvedValueOnce({ ...idle, taskState: "working" });
	mocks.prepare.mockResolvedValue({ task: idle, predecessor: null });
	mocks.capture.mockResolvedValueOnce({
		sha256: "d".repeat(64),
		base: sources[0].base,
		bytes: Buffer.from("user changed checkout"),
	});
	expect(
		await stageReviewedBatchTask(machines, parent, sources[1], control()),
	).toMatchObject({ status: "failed", repairRequired: true });
	expect(mocks.import).not.toHaveBeenCalled();
	expect(mocks.state).toHaveBeenLastCalledWith(draft.id, "failed");
});

it("does not stage legacy, busy, or revised already-imported work", async () => {
	mocks.batch.mockResolvedValueOnce(null);
	expect(
		await stageReviewedBatchTask(machines, parent, sources[0], control()),
	).toBeNull();
	mocks.session.mockResolvedValueOnce({ ...draft, taskState: "working" });
	expect(
		await stageReviewedBatchTask(machines, parent, sources[0], control()),
	).toMatchObject({ status: "not_staged" });
	mocks.session.mockResolvedValueOnce(stagedDestination());
	await expect(
		stageReviewedBatchTask(
			machines,
			parent,
			{ ...sources[0], sha256: "d".repeat(64) },
			control(),
		),
	).rejects.toThrow("re-reviewed");
	expect(mocks.prepare).not.toHaveBeenCalled();
	expect(mocks.import).not.toHaveBeenCalled();
});

it("finalizes an unchanged journal-bound staged checkout with every batch source", async () => {
	const idle = stagedDestination();
	mocks.session.mockImplementation(async (_owner, id) =>
		id === draft.id
			? idle
			: { ...draft, id, taskState: "done", taskReviewState: "reviewed" },
	);
	mocks.prepare.mockResolvedValue({ task: idle, predecessor: null });
	expect(
		await integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).toMatchObject({ status: "done", reviewRequired: true });
	expect(mocks.import).toHaveBeenCalledTimes(2);
	expect(mocks.state).toHaveBeenLastCalledWith(draft.id, "done");
	expect(mocks.save.mock.calls[0][1][0].id).toBe("turn:integration");
});

it("does not finalize a prepared batch while a required source is omitted", async () => {
	const idle = stagedDestination();
	mocks.session.mockResolvedValue(idle);
	mocks.batch.mockResolvedValue({
		taskId: draft.id,
		sourceTaskIds: [...sources.map((source) => source.taskId), "unfinished"],
	});
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).rejects.toThrow("fresh writable");
	expect(mocks.exec).not.toHaveBeenCalled();
	expect(mocks.prepare).not.toHaveBeenCalled();
});

it("preserves the integration for repair after cancellation; never runs final checks", async () => {
	mocks.session
		.mockResolvedValueOnce(draft)
		.mockResolvedValueOnce({ ...draft, providerRef: "integration-vm" });
	mocks.capture.mockResolvedValueOnce({
		sha256: "e".repeat(64),
		base: sources[0].base,
		bytes: Buffer.alloc(0),
	});
	const abort = new AbortController();
	mocks.import.mockImplementationOnce(async () => {
		abort.abort();
	});
	expect(
		await stageReviewedBatchTask(machines, parent, sources[0], {
			signal: abort.signal,
			turnId: "turn",
		}),
	).toMatchObject({ status: "failed" });
	expect(mocks.exec).not.toHaveBeenCalled();
	expect(mocks.state).toHaveBeenLastCalledWith(draft.id, "failed");
});

it("does not duplicate unchanged baseline checks through bare package-script aliases", async () => {
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
		{
			sourcePaths: ["changed.ts"],
			additionalChecks: [
				"pnpm test",
				"pnpm run lint",
				"corepack pnpm typecheck",
				"pnpm build",
			],
		},
	);
	expect(result).toMatchObject({
		status: "done",
		checks: [
			"corepack pnpm run lint",
			"corepack pnpm run typecheck",
			"corepack pnpm run test",
			"corepack pnpm run build",
		],
	});
});

it("binds additional contract checks and every baseline check to the same stable sources", async () => {
	const proof = {
		revision: "b".repeat(40),
		dirty: true,
		sources: [{ path: "changed.ts", sha256: "a".repeat(64) }],
	};
	mocks.sourceEvidence.mockResolvedValue(proof);
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
		{ sourcePaths: ["changed.ts"], additionalChecks: ["focused", "focused"] },
	);
	expect(result).toMatchObject({
		status: "done",
		checks: [
			"focused",
			"corepack pnpm run lint",
			"corepack pnpm run typecheck",
			"corepack pnpm run test",
			"corepack pnpm run build",
		],
	});
	expect(mocks.sourceEvidence).toHaveBeenCalledTimes(2);
	expect(mocks.verify).toHaveBeenCalledTimes(6);
	for (const [, binding] of mocks.verify.mock.calls)
		expect(binding).toMatchObject({
			before: proof,
			after: proof,
			sourcesStable: true,
			cwd: "/repo",
		});
});

it("retains stale integration evidence without committing or declaring success", async () => {
	const before = {
		revision: "b".repeat(40),
		dirty: true,
		sources: [{ path: "changed.ts", sha256: "a".repeat(64) }],
	};
	mocks.sourceEvidence.mockResolvedValueOnce(before).mockResolvedValueOnce({
		...before,
		sources: [{ path: "changed.ts", sha256: "c".repeat(64) }],
	});
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control(), {
			sourcePaths: ["changed.ts"],
		}),
	).resolves.toMatchObject({
		status: "failed",
		stage: "checking",
		repairRequired: true,
	});
	expect(mocks.verify).toHaveBeenCalledTimes(5);
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.state).not.toHaveBeenCalledWith(draft.id, "done");
});
beforeEach(() => {
	vi.resetAllMocks();
	mocks.batch.mockResolvedValue({
		taskId: draft.id,
		sourceTaskIds: sources.map((source) => source.taskId),
	});
	mocks.session.mockImplementation(async (_owner: string, id: string) =>
		id === draft.id
			? draft
			: { ...draft, id, taskState: "done", taskReviewState: "reviewed" },
	);
	mocks.evidence.mockResolvedValue({
		reviews: new Map(sources.map((source) => [source.taskId, source])),
	});
	mocks.prepare.mockResolvedValue({ task: draft, predecessor: null });
	mocks.workspace.mockResolvedValue(workspace);
	mocks.exec.mockImplementation(async (_vm, command: string) => ({
		exitCode: 0,
		stderr: "",
		stdout: command.includes("python3")
			? JSON.stringify({
					recipe: null,
					manifest: JSON.stringify({
						scripts: {
							lint: "lint",
							typecheck: "tsc",
							test: "test",
							build: "build",
						},
					}),
					files: ["pnpm-lock.yaml"],
				})
			: "",
	}));
	mocks.import.mockResolvedValue({ imported: true });
	mocks.capture.mockResolvedValue({
		sha256: "c".repeat(64),
		base: sources[0].base,
		bytes: Buffer.from("complete combined diff"),
	});
	mocks.stop.mockResolvedValue(undefined);
	mocks.completion.mockImplementation(async ({ executeCheck }) => {
		const policy = await mocks.exec.mock.results[0].value;
		for (const group of [
			["git diff --check && git diff --cached --check"],
			...taskVerificationPlan(JSON.parse(policy.stdout)),
		]) {
			for (let offset = 0; offset < group.length; offset += 2) {
				const settled = await Promise.allSettled(
					group.slice(offset, offset + 2).map(executeCheck),
				);
				const failed = settled.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			}
		}
		return { status: "verified" };
	});
});

it("does not commit when the whole-checkout gate rejects the integration", async () => {
	mocks.completion.mockRejectedValue(
		new Error("Checkout changed during checks"),
	);
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result).toMatchObject({ status: "failed", stage: "checking" });
	expect(mocks.commit).not.toHaveBeenCalled();
});

it("overlaps declared independent checks and records each result at its own stable item index", async () => {
	let active = 0;
	let peak = 0;
	mocks.exec.mockImplementation(async (_vm, command: string) => {
		if (command.includes("python3"))
			return {
				exitCode: 0,
				stderr: "",
				stdout: JSON.stringify({
					recipe: JSON.stringify({
						checks: ["check-a", "check-b", "check-c"],
						parallelChecks: [["check-a", "check-b"]],
					}),
					manifest: null,
					files: [],
				}),
			};
		if (command.startsWith("check-")) {
			peak = Math.max(peak, ++active);
			await new Promise((resolve) => setImmediate(resolve));
			active--;
		}
		return {
			exitCode: 0,
			stderr: "",
			stdout: command.startsWith("check-") ? command : "",
		};
	});
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result.status).toBe("done");
	expect(peak).toBe(2);
	const recorded = mocks.save.mock.calls.at(-1)?.[1];
	for (const command of ["check-a", "check-b", "check-c"])
		expect(recorded).toContainEqual(
			expect.objectContaining({
				command,
				status: "completed",
				output: command,
			}),
		);
});

it("flags changes made during verification instead of presenting them as unchanged reviewed imports", async () => {
	mocks.capture.mockResolvedValueOnce({
		bytes: Buffer.from("imported"),
		sha256: "a".repeat(64),
		base: sources[0].base,
	});
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result).toMatchObject({
		status: "done",
		reviewRequired: true,
		verificationChangedPatch: true,
		diff: "complete combined diff",
		sha256: "c".repeat(64),
	});
});

it("imports reviewed siblings without a model turn and runs all baseline checks before requesting review", async () => {
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(mocks.import.mock.calls.map((call) => call[2])).toEqual([
		"first",
		"second",
	]);
	expect(mocks.exec.mock.calls.slice(2).map((call) => call[1])).toEqual([
		"git diff --check && git diff --cached --check",
		"corepack pnpm run lint",
		"corepack pnpm run typecheck",
		"corepack pnpm run test",
		"corepack pnpm run build",
	]);
	expect(result).toMatchObject({
		status: "done",
		reviewRequired: true,
		sha256: "c".repeat(64),
		diff: "complete combined diff",
		truncated: false,
		nextStart: null,
		verificationChangedPatch: false,
		sources,
	});
	expect(mocks.state).toHaveBeenCalledWith(draft.id, "done");
	for (const receipt of (result as { checkResults: object[] }).checkResults) {
		expect(receipt).not.toHaveProperty("stdout");
		expect(receipt).not.toHaveProperty("stderr");
		expect(receipt).not.toHaveProperty("stdoutNextStart");
	}
	const retainedItems = mocks.save.mock.calls.at(-1)?.[1];
	expect(
		retainedItems.find(
			(item: { kind: string; tool?: string }) =>
				item.kind === "dynamicToolCall" &&
				item.tool === "integration_check_evidence",
		).output,
	).toContain('"stdout"');
	expect(result).toMatchObject({
		checkResults: expect.arrayContaining([
			expect.objectContaining({
				command: "corepack pnpm run test",
				reference: "00000000-0000-4000-8000-000000000001",
				exitCode: 0,
				stopped: null,
			}),
		]),
	});
	expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				tool: "integration_check_evidence",
				output: expect.stringContaining('"exitCode":0'),
			}),
			expect.objectContaining({
				kind: "agentMessage",
				text: expect.stringContaining("read_task_output"),
			}),
		]),
	);
	expect(mocks.commit).toHaveBeenCalledOnce();
	expect(mocks.event).toHaveBeenCalledWith(
		expect.objectContaining({ eventType: "completed" }),
	);
});

it("returns a safe actionable binding failure instead of an opaque tool exception", async () => {
	mocks.bind.mockRejectedValue(
		Object.assign(new Error("secret database host and token"), {
			code: "ECONNRESET",
		}),
	);
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result).toMatchObject({
		taskId: draft.id,
		status: "failed",
		repairRequired: true,
		stage: "binding",
		classification: { name: "Error", code: "ECONNRESET" },
	});
	expect(JSON.stringify(result)).not.toContain("secret");
	expect(mocks.state).toHaveBeenCalledWith(draft.id, "failed");
	expect(mocks.import).not.toHaveBeenCalled();
	expect(mocks.commit).not.toHaveBeenCalled();
});

it.each([
	"stale hash",
	"stale base",
	"missing review",
	"other parent",
	"other project",
])("rejects %s before starting compute", async (reason) => {
	if (reason === "missing review")
		mocks.evidence.mockResolvedValue({ reviews: new Map() });
	else if (reason.startsWith("stale"))
		mocks.evidence.mockResolvedValue({
			reviews: new Map(
				sources.map((source) => [
					source.taskId,
					{
						...source,
						[reason === "stale hash" ? "sha256" : "base"]: "d".repeat(64),
					},
				]),
			),
		});
	else
		mocks.session.mockImplementation(async (_owner, id) =>
			id === draft.id
				? draft
				: {
						...draft,
						id,
						taskState: "done",
						taskReviewState: "reviewed",
						...(reason === "other parent"
							? { parentSessionId: "other" }
							: { projectId: "other" }),
					},
		);
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).rejects.toThrow("exact reviewed");
	expect(mocks.prepare).not.toHaveBeenCalled();
});

it("rejects duplicate sources and reused drafts before provisioning", async () => {
	await expect(
		integrateTaskDraft(
			machines,
			parent,
			draft.id,
			[sources[0], sources[0]],
			control(),
		),
	).rejects.toThrow("distinct");
	mocks.session.mockResolvedValue({ ...draft, providerRef: "existing-vm" });
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).rejects.toThrow("draft");
	expect(mocks.bind).not.toHaveBeenCalled();
});

it("retains conflict evidence and fails without publication", async () => {
	mocks.import.mockRejectedValue(new Error("Patch conflict"));
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).resolves.toMatchObject({
		status: "failed",
		stage: "importing",
		repairRequired: true,
	});
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.state).toHaveBeenCalledWith(draft.id, "failed");
	expect(mocks.event).toHaveBeenCalledWith(
		expect.objectContaining({ eventType: "failed" }),
	);
});

it("does not execute check scripts changed by imported work", async () => {
	const implementation = mocks.exec.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture executor");
	mocks.exec.mockImplementation((vm, command, timeout) =>
		command.includes("git diff --name-only")
			? Promise.resolve({ exitCode: 0, stdout: "package.json\n", stderr: "" })
			: implementation(vm, command, timeout),
	);
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).resolves.toMatchObject({
		status: "failed",
		stage: "policy",
		repairRequired: true,
	});
	expect(mocks.exec).toHaveBeenCalledTimes(2);
	expect(mocks.commit).not.toHaveBeenCalled();
});

it("records failed checks and never marks the task done", async () => {
	const implementation = mocks.exec.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture executor");
	mocks.exec.mockImplementation((vm, command, timeout) =>
		command === "corepack pnpm run test"
			? Promise.resolve({ exitCode: 1, stdout: "test failed", stderr: "" })
			: implementation(vm, command, timeout),
	);
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, control()),
	).resolves.toMatchObject({
		status: "failed",
		stage: "checking",
		repairRequired: true,
	});
	expect(mocks.state).not.toHaveBeenCalledWith(draft.id, "done");
	expect(mocks.commit).not.toHaveBeenCalled();
	expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: "commandExecution",
				status: "failed",
				output: "test failed",
			}),
		]),
	);
});

it("preserves output cursors for successful checks rather than rerunning or claiming the preview is complete", async () => {
	const implementation = mocks.exec.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture executor");
	mocks.exec.mockImplementation((vm, command, timeout) =>
		command === "corepack pnpm run test"
			? Promise.resolve({
					exitCode: 0,
					stdout: "first page",
					stderr: "",
					stdoutNextStart: 32000,
				})
			: implementation(vm, command, timeout),
	);
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result).toMatchObject({
		status: "done",
		checkResults: expect.arrayContaining([
			expect.objectContaining({
				command: "corepack pnpm run test",
				exitCode: 0,
				stopped: null,
			}),
		]),
	});
	const retained = mocks.save.mock.calls
		.at(-1)?.[1]
		.filter(
			(item: { tool?: string }) => item.tool === "integration_check_evidence",
		)
		.map((item: { output: string }) => JSON.parse(item.output));
	expect(retained).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				command: "corepack pnpm run test",
				stdoutNextStart: 32000,
				stdout: "first page",
			}),
		]),
	);
	expect(
		mocks.exec.mock.calls.filter(
			([, command]) => command === "corepack pnpm run test",
		),
	).toHaveLength(1);
});

it("retains short diagnostics and Unicode-safe continuation offsets without sending logs to the lead", async () => {
	const implementation = mocks.exec.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture executor");
	mocks.exec.mockImplementation((vm, command, timeout) =>
		command === "corepack pnpm run test"
			? Promise.resolve({
					exitCode: 0,
					stdout: "😀".repeat(2100),
					stderr: "Warning remains visible",
					stdoutNextStart: null,
				})
			: implementation(vm, command, timeout),
	);
	const result = await integrateTaskDraft(
		machines,
		parent,
		draft.id,
		sources,
		control(),
	);
	expect(result).toMatchObject({
		status: "done",
		checkResults: expect.arrayContaining([
			expect.objectContaining({
				command: "corepack pnpm run test",
				stderrPresent: true,
			}),
		]),
	});
	const retained = mocks.save.mock.calls
		.at(-1)?.[1]
		.filter(
			(item: { tool?: string }) => item.tool === "integration_check_evidence",
		)
		.map((item: { output: string }) => JSON.parse(item.output));
	expect(retained).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				command: "corepack pnpm run test",
				stdout: "😀".repeat(2048),
				stdoutNextStart: 2048,
				stderr: "Warning remains visible",
				stderrNextStart: null,
			}),
		]),
	);
});

it.each(["timeout", "output_limit"])(
	"rejects a stopped %s check even if a capture reports zero exit",
	async (stopped) => {
		const implementation = mocks.exec.getMockImplementation();
		if (!implementation) throw new Error("Missing fixture executor");
		mocks.exec.mockImplementation((vm, command, timeout) =>
			command === "corepack pnpm run lint"
				? Promise.resolve({
						exitCode: 0,
						stdout: "incomplete",
						stderr: "",
						stopped,
					})
				: implementation(vm, command, timeout),
		);
		await expect(
			integrateTaskDraft(machines, parent, draft.id, sources, control()),
		).resolves.toMatchObject({ status: "failed", stage: "checking" });
		expect(mocks.commit).not.toHaveBeenCalled();
		expect(mocks.save.mock.calls.at(-1)?.[1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					tool: "integration_check_evidence",
					status: "failed",
					output: expect.stringContaining(`"stopped":"${stopped}"`),
				}),
			]),
		);
	},
);

it("cancels commands only in the designated integration workspace", async () => {
	const controller = new AbortController();
	const implementation = mocks.exec.getMockImplementation();
	if (!implementation) throw new Error("Missing fixture executor");
	mocks.exec.mockImplementation((vm, command, timeout) => {
		if (command === "corepack pnpm run lint") controller.abort();
		return implementation(vm, command, timeout);
	});
	await expect(
		integrateTaskDraft(machines, parent, draft.id, sources, {
			signal: controller.signal,
			turnId: "turn",
		}),
	).resolves.toMatchObject({
		status: "failed",
		stage: "checking",
		classification: { name: "AbortError" },
	});
	expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(workspace, "turn");
	expect(mocks.commit).not.toHaveBeenCalled();
});
