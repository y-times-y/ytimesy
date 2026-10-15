import { beforeEach, expect, it, vi } from "vitest";
import {
	completedChildrenForReview,
	hasDelegatedTasks,
	withDelegationContext,
} from "./agent-delegation-context";

const query = vi.hoisted(() => vi.fn());
const capacity = vi.hoisted(() => vi.fn());
vi.mock("./database", () => ({ database: () => ({ query }) }));
vi.mock("./agent-capacity", () => ({ agentCapacity: capacity }));
beforeEach(() => {
	query.mockReset();
	capacity.mockReset().mockResolvedValue({ maxChildren: 3, available: 2 });
});

it("checks for direct children of the owner's session", async () => {
	query.mockResolvedValue({ rows: [{ present: false }] });
	expect(await hasDelegatedTasks("owner", "parent")).toBe(false);
	expect(query).toHaveBeenLastCalledWith(
		expect.stringContaining("user_id=$1 and parent_session_id=$2"),
		["owner", "parent"],
	);
	query.mockResolvedValue({ rows: [{ present: true }] });
	expect(await hasDelegatedTasks("owner", "parent")).toBe(true);
});

it("collects only completed unreviewed direct children in the owner's project", async () => {
	query.mockResolvedValue({ rows: [{ id: "child", revision: "one" }] });
	expect(
		await completedChildrenForReview("owner", "project", "parent"),
	).toEqual([{ id: "child", revision: "one" }]);
	const [sql, parameters] = query.mock.calls.at(-1) ?? [];
	expect(sql).toContain(
		"user_id=$1 and project_id=$2 and parent_session_id=$3",
	);
	expect(sql).toContain("task_state='done'");
	expect(sql).toContain("task_review_state<>'reviewed'");
	expect(sql).toContain("limit 5");
	expect(parameters).toEqual(["owner", "project", "parent"]);
});

it("appends owner-scoped changes with explicit historical snapshot semantics", async () => {
	query.mockResolvedValue({
		rows: [
			{
				id: "child",
				title: "Fix streaming",
				task_state: "working",
				turn_status: "running",
			},
		],
	});
	const original = [{ role: "user" as const, content: "Fix UI" }];
	const first = await withDelegationContext("owner", "parent", original);
	query.mockResolvedValue({
		rows: [{ id: "child", task_state: "done", turn_status: "completed" }],
	});
	const second = await withDelegationContext("owner", "parent", first);
	expect(query).toHaveBeenLastCalledWith(
		expect.stringContaining("user_id=$1 and parent_session_id=$2"),
		["owner", "parent"],
	);
	expect(second).toHaveLength(3);
	expect(second.at(-1)?.role).toBe("user");
	expect(JSON.stringify(second)).toContain("child");
	expect(JSON.stringify(second)).toContain("Reuse or steer existing tasks");
	expect(JSON.stringify(second.at(-1))).not.toContain("working");
	expect(JSON.stringify(second.at(-1))).toContain(
		"supersedes earlier snapshots",
	);
	expect(JSON.stringify(second)).toContain("at most 3 active children");
});

it("injects nothing and skips the capacity query for a session without children", async () => {
	query.mockResolvedValue({ rows: [] });
	const original = [{ role: "user" as const, content: "Fix UI" }];
	expect(await withDelegationContext("owner", "parent", original)).toBe(
		original,
	);
	expect(capacity).not.toHaveBeenCalled();
	expect(query).toHaveBeenCalledOnce();
});

it("advertises capacity with the first child snapshot", async () => {
	query.mockResolvedValue({ rows: [{ id: "child", task_state: "working" }] });
	const messages = await withDelegationContext("owner", "parent", []);
	expect(JSON.stringify(messages)).toContain("2 additional slots available");
	expect(JSON.stringify(messages)).toContain("worker fleet and your account");
	expect(JSON.stringify(messages)).toContain("3 active children per parent");
});

it("does not re-inject when only fleet-wide capacity changed", async () => {
	query.mockResolvedValue({ rows: [{ id: "child", task_state: "working" }] });
	const first = await withDelegationContext("owner", "parent", []);
	capacity.mockResolvedValue({ maxChildren: 3, available: 7 });
	expect(await withDelegationContext("owner", "parent", first)).toBe(first);
	// Unchanged task status needs no capacity lookup at all.
	expect(capacity).toHaveBeenCalledOnce();
});

it("supersedes an earlier snapshot once every child is gone", async () => {
	query.mockResolvedValue({ rows: [{ id: "child", task_state: "working" }] });
	const first = await withDelegationContext("owner", "parent", []);
	query.mockResolvedValue({ rows: [] });
	const second = await withDelegationContext("owner", "parent", first);
	expect(second).toHaveLength(2);
	expect(second.at(-1)?.content).toContain("[]");
});

it("preserves the exact prior context prefix across model steps and skips unchanged status", async () => {
	query.mockResolvedValue({ rows: [{ id: "child", task_state: "working" }] });
	const first = await withDelegationContext("owner", "parent", [
		{ role: "user", content: "Implement" },
	]);
	const opaqueReasoning = {
		role: "assistant" as const,
		content: [
			{
				type: "reasoning" as const,
				text: "",
				providerOptions: { openai: { encryptedContent: "opaque-fixture" } },
			},
		],
	};
	const prior = [
		...first,
		opaqueReasoning,
		{ role: "assistant" as const, content: "Inspected the repository." },
	];
	const unchanged = await withDelegationContext("owner", "parent", prior);
	expect(unchanged).toEqual(prior);
	query.mockResolvedValue({ rows: [{ id: "child", task_state: "done" }] });
	const updated = await withDelegationContext("owner", "parent", prior);
	expect(updated.slice(0, prior.length)).toEqual(prior);
	expect(updated[first.length]).toBe(opaqueReasoning);
	expect(updated).toHaveLength(prior.length + 1);
	expect(updated.at(-1)?.content).toContain('"task_state":"done"');
});
