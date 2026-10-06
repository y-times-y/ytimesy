import { expect, it, vi } from "vitest";
import { withDelegationContext } from "./agent-delegation-context";

const query = vi.hoisted(() => vi.fn());
vi.mock("./database", () => ({ database: () => ({ query }) }));
vi.mock("./agent-capacity", () => ({
	agentCapacity: async () => ({ maxChildren: 3, available: 2 }),
}));

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
	expect(JSON.stringify(second)).toContain("child");
	expect(JSON.stringify(second)).toContain("Reuse or steer existing tasks");
	expect(JSON.stringify(second.at(-1))).not.toContain("working");
	expect(JSON.stringify(second.at(-1))).toContain(
		"supersedes earlier snapshots",
	);
	expect(JSON.stringify(second)).toContain("at most 3 active children");
});

it("advertises capacity before the first child exists", async () => {
	query.mockResolvedValue({ rows: [] });
	const messages = await withDelegationContext("owner", "parent", []);
	expect(JSON.stringify(messages)).toContain("2 additional slots available");
	expect(JSON.stringify(messages)).toContain("worker fleet and your account");
	expect(JSON.stringify(messages)).toContain("3 active children per parent");
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
