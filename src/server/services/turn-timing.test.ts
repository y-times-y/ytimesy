import { expect, it, vi } from "vitest";
import {
	markTurnPhase,
	timedModelFetch,
	turnSpan,
	turnSpanFetch,
	turnTiming,
	turnTimingLine,
	withTurnTimingMarks,
} from "./turn-timing";

it("formats one line of ids, numbers and fixed codes", () => {
	expect(
		JSON.parse(
			turnTimingLine({
				turnId: "turn-1",
				step: 1,
				startedAt: 10_500,
				queuedAt: 10_000,
				early: false,
				earlyReason: "hook-config-unknown",
				outcome: "completed",
				phases: { leaseAcquired: 12, firstToken: 2100 },
			}),
		),
	).toEqual({
		ytimesy: "turn-timing",
		turn: "turn-1",
		step: 1,
		queuedMs: 500,
		early: false,
		earlyReason: "hook-config-unknown",
		outcome: "completed",
		phases: { leaseAcquired: 12, firstToken: 2100 },
	});
});

it("leaves out what it does not know", () => {
	expect(
		JSON.parse(
			turnTimingLine({ turnId: "t", step: 2, startedAt: 1, phases: {} }),
		),
	).toEqual({ ytimesy: "turn-timing", turn: "t", step: 2, phases: {} });
});

it("keeps each phase's first mark and the first early decision, and writes once", () => {
	let clock = 1_000;
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 1_000,
		now: () => clock,
	});
	clock = 1_040.4;
	timing.mark("leaseAcquired");
	clock = 1_090;
	timing.mark("leaseAcquired");
	timing.early(true, "early");
	timing.early(false, "workspace-ready");
	clock = 1_300;
	timing.write("completed", (line) => lines.push(line));
	timing.write("failed", (line) => lines.push(line));
	expect(lines).toHaveLength(1);
	expect(JSON.parse(lines[0])).toMatchObject({
		early: true,
		earlyReason: "early",
		outcome: "completed",
		phases: { leaseAcquired: 40, end: 300 },
	});
});

it("marks a step's model request start, response headers and first body byte, in order", async () => {
	const marks: string[] = [];
	let release: (() => void) | undefined;
	const upstream: typeof fetch = async () => {
		marks.push("upstream-called");
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
				controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream", "x-request-id": "r1" },
		});
	};
	const timed = timedModelFetch(upstream);
	const response = await withTurnTimingMarks(
		(phase) => marks.push(phase),
		() => timed("https://model.test/v1/responses", { method: "POST" }),
	);
	expect(marks).toEqual([
		"modelFetchStarted",
		"upstream-called",
		"modelHeaders",
	]);
	expect(response.status).toBe(200);
	expect(response.headers.get("x-request-id")).toBe("r1");
	release?.();
	expect(await response.text()).toBe("data: {}\n\ndata: [DONE]\n\n");
	expect(marks).toEqual([
		"modelFetchStarted",
		"upstream-called",
		"modelHeaders",
		"modelFirstByte",
	]);
});

it("passes a model request through untouched outside a durable step", async () => {
	const original = new Response("ok");
	const timed = timedModelFetch(async () => original);
	expect(await timed("https://model.test/")).toBe(original);
	// Marking outside a step is a no-op.
	expect(() => markTurnPhase("egress:vpc")).not.toThrow();
});

it("feeds marks from code under a step into that step's line only", async () => {
	let clock = 0;
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 0,
		now: () => clock,
	});
	await withTurnTimingMarks(
		(phase) => timing.mark(phase),
		async () => {
			clock = 900;
			markTurnPhase("egress:vpc");
		},
	);
	markTurnPhase("egress:relay-1");
	timing.write("completed", (line) => lines.push(line));
	expect(JSON.parse(lines[0]).phases).toEqual({ "egress:vpc": 900, end: 900 });
});

it("records sub-phase spans under a step: first start and duration, then totals for repeats", async () => {
	vi.useFakeTimers({ now: 10_000 });
	try {
		const lines: string[] = [];
		const timing = turnTiming({ turnId: "t", step: 1, startedAt: 10_000 });
		const wait = (ms: number) =>
			new Promise((resolve) => setTimeout(resolve, ms));
		const work = withTurnTimingMarks(
			(phase) => timing.mark(phase),
			async () => {
				await vi.advanceTimersByTimeAsync(100);
				await turnSpan("vm:admit", () => wait(300));
				const failing = turnSpan("vm:guestProbe", async () => {
					await wait(50);
					throw new Error("fetch failed");
				});
				await failing.catch(() => {});
				await turnSpan("vm:guestProbe", () => wait(20));
				const spanned = turnSpanFetch(
					"freestyle",
					async () => new Response("ok"),
				);
				await spanned(
					"https://api.freestyle.sh/v1/vms/abcdef0123456789abcd/exec-await",
					{
						method: "POST",
					},
				);
			},
			(name, at, ms) => timing.span(name, at, ms),
		);
		await vi.runAllTimersAsync();
		await work;
		// Outside the step: untouched, and not recorded.
		await expect(turnSpan("late", async () => 7)).resolves.toBe(7);
		timing.write("completed", (line) => lines.push(line));
		const { spans } = JSON.parse(lines[0]);
		expect(spans["vm:admit"]).toEqual([100, 300]);
		expect(spans["vm:guestProbe"]).toEqual([400, 70, 2, 50]);
		expect(spans["freestyle:POST v1/vms/:id/exec-await"]).toEqual([470, 0]);
		expect(spans.late).toBeUndefined();
	} finally {
		vi.useRealTimers();
	}
});

it("leaves spans out of a line that has none", () => {
	const lines: string[] = [];
	const timing = turnTiming({
		turnId: "t",
		step: 1,
		startedAt: 0,
		now: () => 5,
	});
	timing.write("completed", (line) => lines.push(line));
	expect(JSON.parse(lines[0])).not.toHaveProperty("spans");
});
