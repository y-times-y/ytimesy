import { describe, expect, it, vi } from "vitest";
import { HOUR_MS } from "#/domain/y-settled-threads";
import { ySquaredTools } from "./y-squared-tools";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * HOUR_MS).toISOString();
const run = (
	tools: ReturnType<typeof ySquaredTools>,
	name: string,
	input: unknown,
) =>
	(
		tools[name] as {
			execute: (input: unknown, options: unknown) => Promise<string>;
		}
	).execute(input, { toolCallId: "c", messages: [] });

type Spec = {
	id: string;
	idle: number;
	waitingOn?: string | null;
	working?: boolean;
	extra?: Record<string, unknown>;
	pr?: boolean | null;
};

const extraOf = (spec: Spec) => ({
	id: spec.id,
	lastUserAt: null,
	unpushed: false,
	pendingPush: false,
	prUrl: null,
	mayHaveChanged: false,
	itemCount: 50,
	workspaceAlive: true,
	modelId: "m1",
	areas: [],
	updatedAt: NOW - spec.idle * HOUR_MS,
	...spec.extra,
});

function fixture(specs: Spec[]) {
	const archive = vi.fn(async () => undefined);
	const logDecisions = vi.fn(async () => undefined);
	const prOpen = vi.fn(async (_u: string, _p: string, url: string) => {
		const spec = specs.find((s) => url.endsWith(`/${s.id}`));
		return spec?.pr ?? null;
	});
	const tools = ySquaredTools({
		userId: "u",
		projectId: "p",
		selfId: "y2",
		deps: {
			now: () => NOW,
			list: (async () => [
				{
					id: "y2",
					title: "Y²",
					waitingOn: null,
					workingSince: null,
					updatedAt: null,
				},
				...specs.map((spec) => ({
					id: spec.id,
					title: `Thread ${spec.id}`,
					waitingOn: spec.waitingOn ?? null,
					workingSince: spec.working ? ago(1) : null,
					updatedAt: ago(spec.idle),
				})),
			]) as never,
			threadExtras: (async (_u: string, _p: string, ids: string[]) =>
				specs.filter((s) => ids.includes(s.id)).map(extraOf)) as never,
			crew: (() => null) as never,
			archive,
			prOpen,
			logDecisions,
		},
	});
	return { tools, archive, logDecisions, prOpen };
}

const merged = (id: string) => ({ prUrl: `https://github.com/o/r/pull/${id}` });

describe("settled_threads and archive_settled", () => {
	const specs: Spec[] = [
		{ id: "landed", idle: 30, extra: merged("landed"), pr: false },
		{ id: "nochange", idle: 48 },
		{ id: "fresh", idle: 3 },
		{ id: "unpushed", idle: 99, extra: { unpushed: true } },
		{ id: "openpr", idle: 99, extra: merged("openpr"), pr: true },
		{ id: "unreadable", idle: 99, extra: merged("unreadable"), pr: null },
		{ id: "asking", idle: 99, waitingOn: "question" },
		{ id: "busy", idle: 99, working: true },
		{ id: "chatty", idle: 99, extra: { lastUserAt: NOW - 2 * HOUR_MS } },
		{ id: "pushing", idle: 99, extra: { pendingPush: true } },
		{ id: "failed", idle: 10, waitingOn: "failed" },
	];

	it("lists verdicts from facts, skipping working and waiting threads", async () => {
		const f = fixture(specs);
		const text = await run(f.tools, "settled_threads", {});
		expect(text).toContain("9 finished threads");
		expect(text).toContain("the rules would archive 3");
		expect(text).not.toContain("asking");
		expect(text).not.toContain("busy");
		expect(text).toMatch(/landed.*→ archive/);
		expect(text).toMatch(
			/unpushed.*→ keep: has committed or edited work that was not pushed/,
		);
		// kept threads are logged; archive verdicts are not decisions yet
		const rows = (
			f.logDecisions.mock.calls[0] as unknown as [
				string,
				string,
				{ sessionId: string; decision: string }[],
			]
		)[2];
		expect(rows.every((row) => row.decision === "kept")).toBe(true);
		expect(rows.map((row) => row.sessionId)).not.toContain("landed");
	});

	it("archives only what the rules allow, in one batch, and logs every outcome", async () => {
		const f = fixture(specs);
		const out = await run(f.tools, "archive_settled", {
			ids: specs.map((s) => s.id),
		});
		expect(
			f.archive.mock.calls.map((c) => (c as unknown as string[])[1]).sort(),
		).toEqual(["failed", "landed", "nochange"]);
		expect(out.split("\n")[0]).toMatch(/^Archived 3 settled threads; kept 8 /);
		for (const id of [
			"unpushed",
			"openpr",
			"unreadable",
			"asking",
			"busy",
			"chatty",
			"pushing",
			"fresh",
		])
			expect(
				f.archive.mock.calls.map((c) => (c as unknown as string[])[1]),
			).not.toContain(id);
		const rows = (
			f.logDecisions.mock.calls[0] as unknown as [
				string,
				string,
				{ sessionId: string; decision: string; reason: string }[],
			]
		)[2];
		expect(rows.filter((row) => row.decision === "archived")).toHaveLength(3);
		expect(rows.find((row) => row.sessionId === "unpushed")).toMatchObject({
			decision: "refused",
		});
		expect(rows.every((row) => row.reason.length > 0)).toBe(true);
	});

	it("never archives unpushed work or a pending question even when marked obsolete", async () => {
		const f = fixture(specs);
		await run(f.tools, "archive_settled", {
			ids: ["unpushed", "pushing", "asking", "openpr"],
			discard: ["unpushed", "pushing", "asking", "openpr"],
		});
		expect(f.archive).not.toHaveBeenCalled();
	});

	it("a discard mark archives a duplicate after 6 h, not a fresh one", async () => {
		const f = fixture([
			{ id: "dup", idle: 8 },
			{ id: "new", idle: 2 },
		]);
		const out = await run(f.tools, "archive_settled", {
			ids: ["dup", "new"],
			discard: ["dup", "new"],
		});
		expect(
			f.archive.mock.calls.map((c) => (c as unknown as string[])[1]),
		).toEqual(["dup"]);
		expect(out).toContain("Archived 1 settled thread");
	});

	it("does not ask GitHub when something else already keeps the thread", async () => {
		const f = fixture([
			{
				id: "x",
				idle: 99,
				extra: { ...merged("x"), unpushed: true },
				pr: false,
			},
		]);
		await run(f.tools, "settled_threads", {});
		expect(f.prOpen).not.toHaveBeenCalled();
	});

	it("still archives when the decision log fails", async () => {
		const f = fixture([{ id: "nochange", idle: 48 }]);
		const failing = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				now: () => NOW,
				list: (async () => [
					{
						id: "nochange",
						title: "t",
						waitingOn: null,
						workingSince: null,
						updatedAt: ago(48),
					},
				]) as never,
				threadExtras: (async () => [
					extraOf({ id: "nochange", idle: 48 }),
				]) as never,
				crew: (() => null) as never,
				archive: f.archive,
				logDecisions: async () => {
					throw new Error("table missing");
				},
			},
		});
		expect(
			await run(failing, "archive_settled", { ids: ["nochange"] }),
		).toContain("Archived 1");
		expect(f.archive).toHaveBeenCalledOnce();
	});

	it("says nothing was archived when every thread stays", async () => {
		const f = fixture([{ id: "fresh", idle: 3 }]);
		expect(
			(await run(f.tools, "archive_settled", { ids: ["fresh"] })).split(
				"\n",
			)[0],
		).toBe("Nothing archived.");
	});
});

describe("reuse_candidates", () => {
	it("lists a related idle thread with a warm machine and nothing for a clean checkout", async () => {
		const archive = vi.fn();
		const crewRow = {
			sessionId: "a",
			title: "Fix sign-up form validation",
			state: "finished",
			waitingOn: null,
			prUrl: null,
			lastReply: null,
			lastRequest: "validate the email on the sign-up form",
			updatedAt: NOW - 2 * HOUR_MS,
			createdAt: 0,
			lastActiveAt: 0,
			workingSince: null,
		};
		const tools = ySquaredTools({
			userId: "u",
			projectId: "p",
			selfId: "y2",
			deps: {
				now: () => NOW,
				list: (async () => [
					{
						id: "a",
						title: "x",
						waitingOn: null,
						workingSince: null,
						updatedAt: ago(2),
					},
				]) as never,
				crew: (() => ({
					list: async () => ({ rows: [crewRow], reconciled: true }),
				})) as never,
				threadExtras: (async () => [
					extraOf({ id: "a", idle: 2, extra: { areas: ["signup"] } }),
				]) as never,
				archive,
			},
		});
		const hit = await run(tools, "reuse_candidates", {
			task: "Also validate the password on the sign-up form",
		});
		expect(hit).toContain("a ");
		expect(hit).toContain("warm machine");
		expect(
			await run(tools, "reuse_candidates", {
				task: "sign-up form",
				cleanCheckout: true,
			}),
		).toBe("No idle thread fits: start a new one.");
		expect(
			await run(tools, "reuse_candidates", {
				task: "Rewrite the billing export",
			}),
		).toContain("No idle thread fits");
	});
});
