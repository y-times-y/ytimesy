import { describe, expect, it, vi } from "vitest";
import { agentSessionMachineSlug } from "#/domain/agent-session";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";

vi.mock("./database", () => ({
	database: () => {
		throw new Error("no database in this test");
	},
}));

import type { ApiTurn } from "./api-turns";
import { subagentPort } from "./turn-box-subagent-port";

const ROOT = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const turn = { id: "t1", user_id: "u1", session_id: ROOT } as ApiTurn;
const family = async () =>
	[
		{
			id: ROOT,
			userId: "u1",
			projectId: "p1",
			parentSessionId: null,
			providerRef: "vm-root",
			harness: "api",
		},
		{
			id: CHILD,
			userId: "u1",
			projectId: "p1",
			parentSessionId: ROOT,
			providerRef: "vm-child",
			harness: "api",
		},
	] as never;

function world() {
	const calls: { dep: string; args: unknown[] }[] = [];
	const record =
		(dep: string, answer: unknown = null) =>
		async (...args: unknown[]) => {
			calls.push({ dep, args });
			return answer;
		};
	const run = new Proxy(
		{},
		{ get: (_t, dep) => record(String(dep), { ok: String(dep) }) },
	) as never;
	const machines = () => ({ marker: "edge-machines" }) as never;
	return {
		calls,
		// As the box sends them: through JSON, where an omitted (undefined)
		// argument in the array arrives as null.
		call: (dep: Parameters<typeof subagentPort>[1], args: unknown[]) =>
			subagentPort(turn, dep, JSON.parse(JSON.stringify(args)), {
				run,
				family,
				machines,
			}),
	};
}

const refused = (promise: Promise<unknown>) =>
	expect(promise).rejects.toBeInstanceOf(TurnBoxPortForbidden);

describe("subagent port: a box reaches only its own chat and helpers", () => {
	it("serves the turn's chat and its helpers", async () => {
		const w = world();
		await w.call("tree", ["u1", ROOT]);
		await w.call("takeReport", [CHILD]);
		await w.call("stop", [CHILD, { now: true }]);
		expect(w.calls.map((call) => call.dep)).toEqual([
			"tree",
			"takeReport",
			"stop",
		]);
		expect(w.calls[2]?.args).toEqual([CHILD, { now: true }]);
	});

	it("refuses another user and a chat outside the turn's family", async () => {
		const w = world();
		await refused(w.call("tree", ["u2", ROOT]));
		await refused(w.call("takeReport", [STRANGER]));
		await refused(w.call("markFailed", [STRANGER]));
		await refused(w.call("usageWindowsOpen", ["u2"]));
		expect(w.calls).toEqual([]);
	});

	it("opens a task only under its own chat and project, never as a shared writer", async () => {
		const w = world();
		await w.call("openTask", [
			{
				userId: "u1",
				projectId: "p1",
				parentSessionId: ROOT,
				title: "Read",
				harness: "api",
				modelId: "m",
				prompt: "brief",
				placement: "shared",
				access: "read_only",
				sharedWriter: true,
			},
		]);
		expect(w.calls[0]?.args[0]).toMatchObject({
			userId: "u1",
			projectId: "p1",
			parentSessionId: ROOT,
			sharedWriter: false,
		});
		await refused(
			w.call("openTask", [
				{ userId: "u1", projectId: "p2", parentSessionId: ROOT },
			]),
		);
		await refused(
			w.call("openTask", [
				{ userId: "u1", projectId: "p1", parentSessionId: STRANGER },
			]),
		);
	});

	it("forks only a family VM, under a family name, with the edge's machines", async () => {
		const w = world();
		await w.call("fork", [
			{ parentVm: "vm-root", slug: agentSessionMachineSlug(CHILD) },
		]);
		expect(w.calls[0]?.args[0]).toMatchObject({
			parentVm: "vm-root",
			machines: { marker: "edge-machines" },
		});
		await refused(
			w.call("fork", [
				{ parentVm: "vm-other", slug: agentSessionMachineSlug(CHILD) },
			]),
		);
		await refused(
			w.call("fork", [
				{ parentVm: "vm-root", slug: agentSessionMachineSlug(STRANGER) },
			]),
		);
	});

	it("starts and stops a helper with no options, as the box sends them (null after JSON)", async () => {
		const w = world();
		await w.call("start", [
			{ userId: "u1", sessionId: ROOT },
			CHILD,
			undefined,
		]);
		expect(w.calls[0]?.args[1]).toBe(CHILD);
		expect(w.calls[0]?.args[2]).toBeUndefined();
		await w.call("stop", [CHILD, undefined]);
		expect(w.calls[1]?.args).toEqual([CHILD, { now: false }]);
	});

	it("rebuilds a start's scope and a sender's record itself", async () => {
		const w = world();
		await w.call("start", [
			{ userId: "u1", sessionId: ROOT, projectId: "evil", harnessId: "x" },
			CHILD,
			{ reasoning: "high" },
		]);
		expect(w.calls[0]?.args).toEqual([
			{
				userId: "u1",
				projectId: "p1",
				sessionId: ROOT,
				harnessId: "api",
				createNew: false,
			},
			CHILD,
			{ reasoning: "high" },
		]);
		// The task must be a child of the named parent.
		await refused(w.call("start", [{ userId: "u1", sessionId: CHILD }, ROOT]));
		await w.call("message", [
			{ id: ROOT, userId: "u2", projectId: "evil" },
			CHILD,
			"hello",
			"r1",
		]);
		const sender = w.calls[1]?.args[0] as { userId: string; projectId: string };
		expect(sender).toMatchObject({ id: ROOT, userId: "u1", projectId: "p1" });
		await refused(w.call("message", [{ id: STRANGER }, CHILD, "hello", "r2"]));
		await w.call("interrupt", [null, { id: ROOT }, CHILD, "now", "r3"]);
		expect(w.calls[2]?.args[0]).toEqual({ marker: "edge-machines" });
	});

	it("checks a provider ref's shape and a release's project", async () => {
		const w = world();
		await w.call("saveProviderRef", [CHILD, "vm_fork-123"]);
		await refused(w.call("saveProviderRef", [CHILD, "../../etc"]));
		await w.call("releaseStart", ["u1", "p1", CHILD]);
		await refused(w.call("releaseStart", ["u1", "p2", CHILD]));
	});
});
