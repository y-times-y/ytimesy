import { expect, it, vi } from "vitest";
import { launchReadyTasks } from "./ready-task-launch";

const tasks = [
	{
		id: "first",
		title: "First contract",
		prompt: "Exact first contract",
		owns: ["src/a.ts"],
	},
	{
		id: "second",
		title: "Second contract",
		prompt: "Exact second contract",
		owns: ["src/b.ts"],
	},
];
const signal = new AbortController().signal;

it("starts independent contracts together and preserves indexed outcomes", async () => {
	let resolveFirst!: (value: unknown) => void;
	const launch = vi.fn(async (_task, index) =>
		index === 0
			? new Promise((resolve) => {
					resolveFirst = resolve;
				})
			: { taskId: "second-created" },
	);
	const pending = launchReadyTasks({
		request: { tasks },
		available: async () => 2,
		launch,
		signal,
	});
	await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
	resolveFirst({ taskId: "first-created" });
	expect(await pending).toEqual({
		tasks: [
			{ id: "first", result: { taskId: "first-created" } },
			{ id: "second", result: { taskId: "second-created" } },
		],
	});
});

it("rejects invalid ownership and unavailable capacity before creating anything", async () => {
	const launch = vi.fn();
	const available = vi.fn(async () => 1);
	await expect(
		launchReadyTasks({ request: { tasks }, available, launch, signal }),
	).rejects.toThrow("No tasks created");
	await expect(
		launchReadyTasks({
			request: { tasks: [tasks[0], { ...tasks[1], owns: ["src"] }] },
			available,
			launch,
			signal,
		}),
	).rejects.toThrow("ownership overlaps");
	await expect(
		launchReadyTasks({
			request: { tasks: [tasks[0], { ...tasks[1], owns: ["../secret"] }] },
			available,
			launch,
			signal,
		}),
	).rejects.toThrow();
	expect(available).toHaveBeenCalledOnce();
	expect(launch).not.toHaveBeenCalled();
});

it("settles every started launch and retains successes without replaying uncertain effects", async () => {
	const launch = vi.fn(async (_task, index) => {
		if (index === 0) throw new Error("private transport detail");
		return { taskId: "retained", status: "draft", startError: "Not admitted" };
	});
	const result = await launchReadyTasks({
		request: { tasks },
		available: async () => 2,
		launch,
		signal,
	});
	expect(result.tasks[0]).toMatchObject({ status: "uncertain" });
	expect(result.tasks[1]).toEqual({
		id: "second",
		result: { taskId: "retained", status: "draft", startError: "Not admitted" },
	});
	expect(JSON.stringify(result)).not.toContain("private transport detail");
	expect(launch).toHaveBeenCalledTimes(2);
});

it("does not launch after cancellation", async () => {
	const launch = vi.fn();
	await expect(
		launchReadyTasks({
			request: { tasks },
			available: async () => 2,
			launch,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow();
	expect(launch).not.toHaveBeenCalled();
});
