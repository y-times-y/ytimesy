import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";
import type { DurableWorkPlan } from "#/domain/durable-work-plan";
import { validateWorkPlan } from "#/domain/durable-work-plan";
import { ChildAdmissionDenied } from "../adapters/agent-capacity";
import type { AgentSessionRecord } from "../adapters/agent-sessions";
import { dispatchDurableWork, scheduleDurableWork } from "./durable-work-plan";

const mocks = vi.hoisted(() => ({
	tasks: new Map<string, unknown>(),
	plan: null as unknown,
	save: vi.fn(),
	slots: vi.fn(),
	start: vi.fn(),
	integrate: vi.fn(),
	launched: new Set<string>(),
	reviews: new Map<string, unknown>(),
	patch: vi.fn(),
	history: [] as DurableWorkPlan[],
}));
vi.mock("../adapters/agent-sessions", () => ({
	agentSessionForOwner: async (owner: string, id: string) => {
		const task = mocks.tasks.get(id) as AgentSessionRecord;
		return task?.userId === owner ? task : null;
	},
	agentSessionById: async (id: string) => mocks.tasks.get(id),
}));
vi.mock("../adapters/work-plans", () => ({
	insertWorkPlan: async (
		_owner: string,
		_parent: string,
		plan: DurableWorkPlan,
	) => {
		mocks.plan = structuredClone(plan);
		return plan;
	},
	claimWorkPlan: async () =>
		mocks.plan
			? {
					parentId: parent.id,
					token: randomUUID(),
					plan: structuredClone(mocks.plan),
				}
			: null,
	saveClaimedWorkPlan: mocks.save,
	notifyBlockedWorkPlan: vi.fn(),
	renewWorkPlanClaim: vi.fn(),
	taskHasDurableLaunch: async (id: string) => mocks.launched.has(id),
}));
vi.mock("../adapters/agent-capacity", async (importOriginal) => ({
	...(await importOriginal<typeof import("../adapters/agent-capacity")>()),
	availableChildSlots: mocks.slots,
}));
vi.mock("../adapters/task-patch-evidence", () => ({
	taskPatchEvidence: async () => ({ reviews: mocks.reviews, imports: [] }),
}));
vi.mock("../jobs/queue", () => ({
	enqueueWorkPlan: vi.fn(),
	enqueueAgentTaskEvent: vi.fn(),
}));
vi.mock("./harness-workspace-session", () => ({
	startPreparedAgentTask: mocks.start,
}));
vi.mock("./automated-task-integration", () => ({
	integrateTaskDraft: mocks.integrate,
}));
vi.mock("./reviewed-task-import", () => ({ captureTaskPatch: mocks.patch }));
vi.mock("./session-workspace-machines", () => ({
	machinesForAgentSession: (machines: unknown) => machines,
}));
const parent = {
	id: randomUUID(),
	userId: "alice",
	projectId: randomUUID(),
	parentSessionId: null,
	candidateIndex: null,
	harness: "api",
	turnStatus: "completed",
} as AgentSessionRecord;
function draft(
	id = randomUUID(),
	changes: Partial<AgentSessionRecord> = {},
): AgentSessionRecord {
	const task = {
		...parent,
		id,
		parentSessionId: parent.id,
		taskState: "draft",
		taskPrompt: "Implement and verify.",
		listedModelId: "explicit-model",
		taskPlacement: "fresh",
		taskAccess: "read_write",
		taskExecution: "parallel",
		dependsOnSessionId: null,
		providerRef: null,
		selectedBranch: null,
		baseBranch: null,
		...changes,
	} as AgentSessionRecord;
	mocks.tasks.set(task.id, task);
	return task;
}
function node(
	task: AgentSessionRecord,
	id = "first",
	dependsOn: string[] = [],
	kind: "task" | "integration" = "task",
) {
	return {
		id,
		taskId: task.id,
		objective: "Implement",
		estimatedSeconds: 10,
		owns: [`src/${id}.ts`],
		dependsOn,
		kind,
	};
}
beforeEach(() => {
	mocks.tasks.clear();
	mocks.tasks.set(parent.id, parent);
	mocks.plan = null;
	mocks.history.length = 0;
	mocks.launched.clear();
	mocks.reviews.clear();
	mocks.save.mockReset().mockImplementation(async (_id, _token, plan) => {
		mocks.plan = structuredClone(plan);
		mocks.history.push(structuredClone(plan));
	});
	mocks.slots.mockReset().mockResolvedValue(1);
	mocks.start.mockReset().mockImplementation((_scope, id) =>
		Effect.sync(() => {
			mocks.launched.add(id);
			(mocks.tasks.get(id) as AgentSessionRecord).taskState = "working";
		}),
	);
	mocks.integrate.mockReset().mockResolvedValue({ status: "done" });
	mocks.patch
		.mockReset()
		.mockResolvedValue({ base: "a".repeat(40), sha256: "b".repeat(64) });
});

it("validates cycles, overlapping ownership, duplicate drafts and explicit join nodes", () => {
	const a = draft(),
		b = draft();
	expect(() =>
		validateWorkPlan({ tasks: [node(a, "a", ["b"]), node(b, "b", ["a"])] }),
	).toThrow("cycle");
	expect(() =>
		validateWorkPlan({ tasks: [node(a, "a"), node(a, "b")] }),
	).toThrow("only once");
	expect(() =>
		validateWorkPlan({
			tasks: [node(a, "a"), { ...node(b, "b"), owns: ["src/a.ts"] }],
		}),
	).toThrow("overlaps");
	expect(() =>
		validateWorkPlan({
			tasks: [node(a, "a"), node(b, "b", ["a"], "integration")],
		}),
	).toThrow("two to eight");
});

it("dispatches critical-path-ready drafts within capacity, saving intent before side effects", async () => {
	const a = draft(),
		b = draft(),
		c = draft(undefined, {
			taskExecution: "stacked",
			dependsOnSessionId: b.id,
		});
	await scheduleDurableWork(parent, "request", {
		tasks: [node(a, "a"), node(b, "b"), node(c, "c", ["b"])],
	});
	await dispatchDurableWork({} as never);
	expect(mocks.start).toHaveBeenCalledOnce();
	expect(mocks.start.mock.calls[0][1]).toBe(b.id);
	expect(
		mocks.history.some(
			(plan) =>
				plan.nodes.find((entry) => entry.id === "b")?.state === "dispatching",
		),
	).toBe(true);
	expect(
		(mocks.plan as DurableWorkPlan).nodes.find((entry) => entry.id === "b")
			?.state,
	).toBe("started");
});

it("observes interrupted durable launches and never replays reservations without queue acceptance", async () => {
	const a = draft();
	await scheduleDurableWork(parent, "request", { tasks: [node(a)] });
	(mocks.plan as DurableWorkPlan).nodes[0].state = "dispatching";
	a.taskState = "working";
	await dispatchDurableWork({} as never);
	expect(mocks.start).not.toHaveBeenCalled();
	expect((mocks.plan as DurableWorkPlan).status).toBe("blocked");
	expect((mocks.plan as DurableWorkPlan).nodes[0].state).toBe("uncertain");
	(mocks.plan as DurableWorkPlan).nodes[0].state = "dispatching";
	(mocks.plan as DurableWorkPlan).status = "active";
	mocks.launched.add(a.id);
	await dispatchDurableWork({} as never);
	expect(mocks.start).not.toHaveBeenCalled();
	expect((mocks.plan as DurableWorkPlan).nodes[0].state).toBe("started");
});

it("keeps safe admission races pending and blocks changed draft contracts", async () => {
	const a = draft();
	await scheduleDurableWork(parent, "request", { tasks: [node(a)] });
	mocks.start.mockReturnValue(
		Effect.fail(new ChildAdmissionDenied("capacity")),
	);
	await dispatchDurableWork({} as never);
	expect((mocks.plan as DurableWorkPlan).nodes[0].state).toBe("pending");
	a.listedModelId = "changed-model";
	mocks.start.mockClear();
	await dispatchDurableWork({} as never);
	expect(mocks.start).not.toHaveBeenCalled();
	expect((mocks.plan as DurableWorkPlan).status).toBe("blocked");
});

it("integrates only exact reviewed completed siblings, preserving failures and requiring review of the join", async () => {
	const a = draft(),
		b = draft(),
		join = draft();
	await scheduleDurableWork(parent, "request", {
		tasks: [
			node(a, "a"),
			node(b, "b"),
			node(join, "join", ["a", "b"], "integration"),
		],
	});
	for (const task of [a, b]) {
		task.taskState = "done";
		task.taskReviewState = "reviewed";
		task.providerRef = `vm-${task.id}`;
		mocks.reviews.set(task.id, {
			taskId: task.id,
			base: "a".repeat(40),
			sha256: "b".repeat(64),
		});
		const sourceNode = (mocks.plan as DurableWorkPlan).nodes.find(
			(entry) => entry.taskId === task.id,
		);
		if (!sourceNode) throw new Error("Missing source node");
		sourceNode.state = "started";
	}
	await dispatchDurableWork({} as never);
	expect(mocks.integrate).toHaveBeenCalledOnce();
	expect(mocks.start).not.toHaveBeenCalled();
	expect((mocks.plan as DurableWorkPlan).status).toBe("active");
	const joinNode = (mocks.plan as DurableWorkPlan).nodes.find(
		(entry) => entry.taskId === join.id,
	);
	if (!joinNode) throw new Error("Missing join node");
	joinNode.state = "pending";
	mocks.patch.mockResolvedValue({
		base: "a".repeat(40),
		sha256: "c".repeat(64),
	});
	mocks.integrate.mockClear();
	await expect(dispatchDurableWork({} as never)).rejects.toThrow("changed");
	expect(mocks.integrate).not.toHaveBeenCalled();
	expect((mocks.plan as DurableWorkPlan).status).toBe("blocked");
});
