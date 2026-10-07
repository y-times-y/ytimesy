import { expect, it, vi } from "vitest";
import { launchReadyTasks, readyTaskPrompt } from "./ready-task-launch";

const tasks = [
	{
		id: "first",
		title: "First contract",
		prompt: "Exact first contract",
		owns: ["src/a.ts"],
		focusedChecks: ["test src/a.test.ts"],
		verificationPaths: ["src/a.ts"],
	},
	{
		id: "second",
		title: "Second contract",
		prompt: "Exact second contract",
		owns: ["src/b.ts"],
		focusedChecks: ["test src/b.test.ts"],
		verificationPaths: ["src/b.ts"],
	},
];
const signal = new AbortController().signal;
const finalChecks = ["test all", "typecheck"];

it("prepares one unstarted integration draft after successful launch, never replays builders on preparation failure", async () => {
	const launch = vi.fn(async (_task, index) => ({ taskId: `child-${index}` }));
	const prepareIntegration = vi.fn(async () => ({ taskId: "integration" }));
	const input = {
		request: { tasks, finalChecks, perBuilderChecks: [] },
		available: async () => 2,
		launch,
		prepareIntegration,
		signal,
	};
	expect(await launchReadyTasks(input)).toMatchObject({
		integration: { taskId: "integration" },
	});
	expect(prepareIntegration).toHaveBeenCalledOnce();
	prepareIntegration.mockRejectedValueOnce(new Error("private VM message"));
	const failed = await launchReadyTasks(input);
	expect(failed.integration).toMatchObject({ status: "unavailable" });
	expect(JSON.stringify(failed)).not.toContain("private VM message");
	expect(launch).toHaveBeenCalledTimes(4);
	launch.mockRejectedValueOnce(new Error("launch uncertain"));
	await launchReadyTasks(input);
	expect(prepareIntegration).toHaveBeenCalledTimes(2);
});

it("rejects a split whose estimated savings do not cover added coordination before any effects", async () => {
	const launch = vi.fn();
	const available = vi.fn(async () => 2);
	const prepareIntegration = vi.fn();
	await expect(
		launchReadyTasks({
			request: {
				tasks,
				finalChecks,
				perBuilderChecks: [],
				performancePlan: {
					singleBuilderSeconds: 100,
					parallelBuilderSeconds: 70,
					additionalCoordinationSeconds: 30,
				},
			},
			available,
			launch,
			prepareIntegration,
			signal,
		}),
	).rejects.toThrow("coordination overhead");
	expect(available).not.toHaveBeenCalled();
	expect(launch).not.toHaveBeenCalled();
	expect(prepareIntegration).not.toHaveBeenCalled();
});

it("supports directory ownership with exact verification files and rejects out-of-scope bindings", async () => {
	const launch = vi.fn(async () => ({ taskId: "created" }));
	const available = vi.fn(async () => 2);
	const directoryTasks = [
		{ ...tasks[0], owns: ["src/a"], verificationPaths: ["src/a/file.ts"] },
		tasks[1],
	];
	const result = await launchReadyTasks({
		request: { tasks: directoryTasks, finalChecks, perBuilderChecks: [] },
		available,
		launch,
		signal,
	});
	expect(result.finalVerification.sourcePaths).toEqual([
		"src/a/file.ts",
		"src/b.ts",
	]);
	launch.mockClear();
	await expect(
		launchReadyTasks({
			request: {
				tasks: [
					{ ...directoryTasks[0], verificationPaths: ["src/ab/outside.ts"] },
					tasks[1],
				],
				finalChecks,
				perBuilderChecks: [],
			},
			available,
			launch,
			signal,
		}),
	).rejects.toThrow("within declared ownership");
	expect(launch).not.toHaveBeenCalled();
});

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
		request: { tasks, finalChecks, perBuilderChecks: [] },
		available: async () => 2,
		launch,
		signal,
	});
	await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
	resolveFirst({ taskId: "first-created" });
	expect(await pending).toMatchObject({
		finalVerification: {
			commands: finalChecks,
			sourcePaths: ["src/a.ts", "src/b.ts"],
		},
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
		launchReadyTasks({
			request: { tasks, finalChecks, perBuilderChecks: [] },
			available,
			launch,
			signal,
		}),
	).rejects.toThrow("No tasks created");
	await expect(
		launchReadyTasks({
			request: {
				tasks: [tasks[0], { ...tasks[1], owns: ["src"] }],
				finalChecks,
				perBuilderChecks: [],
			},
			available,
			launch,
			signal,
		}),
	).rejects.toThrow("ownership overlaps");
	await expect(
		launchReadyTasks({
			request: {
				tasks: [tasks[0], { ...tasks[1], owns: ["../secret"] }],
				finalChecks,
				perBuilderChecks: [],
			},
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
		request: { tasks, finalChecks, perBuilderChecks: [] },
		available: async () => 2,
		launch,
		signal,
	});
	expect(result.tasks[0]).toMatchObject({ status: "uncertain" });
	expect(result.tasks[1]).toEqual({
		id: "second",
		focusedChecks: tasks[1].focusedChecks,
		verificationPaths: tasks[1].verificationPaths,
		owns: tasks[1].owns,
		result: { taskId: "retained", status: "draft", startError: "Not admitted" },
	});
	expect(JSON.stringify(result)).not.toContain("private transport detail");
	expect(launch).toHaveBeenCalledTimes(2);
});

it("does not launch after cancellation", async () => {
	const launch = vi.fn();
	await expect(
		launchReadyTasks({
			request: { tasks, finalChecks, perBuilderChecks: [] },
			available: async () => 2,
			launch,
			signal: AbortSignal.abort(),
		}),
	).rejects.toThrow();
	expect(launch).not.toHaveBeenCalled();
});

it("requires verification ownership before launch and rejects duplicated final checks", async () => {
	const launch = vi.fn();
	const available = vi.fn(async () => 2);
	const request = {
		tasks: [{ ...tasks[0], focusedChecks: ["typecheck"] }, tasks[1]],
		finalChecks,
		perBuilderChecks: [],
	};
	await expect(
		launchReadyTasks({ request, available, launch, signal }),
	).rejects.toThrow("assigned to both");
	expect(available).not.toHaveBeenCalled();
	expect(launch).not.toHaveBeenCalled();
	await launchReadyTasks({
		request: { ...request, perBuilderChecks: ["typecheck"] },
		available,
		launch,
		signal,
	});
	expect(launch).toHaveBeenCalledTimes(2);
	expect(
		readyTaskPrompt(tasks[0], { finalChecks, perBuilderChecks: [] }),
	).toContain("First handoff: exact scoped diff");
	await expect(
		launchReadyTasks({
			request: { tasks, finalChecks: [], perBuilderChecks: [] },
			available,
			launch,
			signal,
		}),
	).rejects.toThrow();
});
