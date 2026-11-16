import { expect, it, vi } from "vitest";

const github = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../github", () => ({
	githubClient: () => github.client,
	repositoryOwnerName: (fullName: string) => {
		const [owner, repo] = fullName.split("/");
		return { owner, repo };
	},
}));

import { runPullRequestAction } from "./pull-request-actions";

const refused = Object.assign(
	new Error("Unknown error - https://docs.github.com/rest/actions"),
	{ status: 403 },
);

async function messageOf(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Response)
			return ((await error.json()) as { error: string }).error;
		throw error;
	}
	return null;
}

it("says why GitHub will not re-run a job, from the job's own annotation", async () => {
	github.client = {
		actions: {
			reRunJobForWorkflowRun: async () => {
				throw refused;
			},
		},
		checks: {
			listAnnotations: async () => ({
				data: [
					{
						message:
							"The job was not started because recent account payments have failed.",
					},
				],
			}),
		},
	};
	await expect(
		messageOf(
			runPullRequestAction("t", "o/r", 1, {
				action: "rerun",
				target: { jobId: 9 },
			}),
		),
	).resolves.toBe(
		"GitHub refused this: The job was not started because recent account payments have failed.",
	);
});

it("falls back to the general explanation when the job has no annotation to read", async () => {
	github.client = {
		actions: {
			reRunJobForWorkflowRun: async () => {
				throw refused;
			},
		},
		checks: {
			listAnnotations: async () => {
				throw new Error("nope");
			},
		},
	};
	const message = await messageOf(
		runPullRequestAction("t", "o/r", 1, {
			action: "rerun",
			target: { jobId: 9 },
		}),
	);
	expect(message).toContain("GitHub Actions is blocked");
});

it("re-runs the job when GitHub accepts", async () => {
	const rerun = vi.fn(async () => ({}));
	github.client = { actions: { reRunJobForWorkflowRun: rerun } };
	await runPullRequestAction("t", "o/r", 1, {
		action: "rerun",
		target: { jobId: 9 },
	});
	expect(rerun).toHaveBeenCalledWith({ owner: "o", repo: "r", job_id: 9 });
});

it("shows what GitHub says about a job that never started when it has no log", async () => {
	github.client = {
		actions: {
			downloadJobLogsForWorkflowRun: async () => {
				throw refused;
			},
		},
		checks: {
			listAnnotations: async () => ({
				data: [
					{
						message:
							"The job was not started because recent account payments have failed.",
					},
				],
			}),
		},
	};
	const { actionsJobLog } = await import("./pull-request-actions");
	const { log } = await actionsJobLog("t", "o/r", 9);
	expect(log).toContain("it did not run");
	expect(log).toContain("recent account payments have failed");
});

it("explains a missing log when there is nothing to show", async () => {
	github.client = {
		actions: {
			downloadJobLogsForWorkflowRun: async () => {
				throw refused;
			},
		},
		checks: { listAnnotations: async () => ({ data: [] }) },
	};
	const { actionsJobLog } = await import("./pull-request-actions");
	await actionsJobLog("t", "o/r", 9).then(
		() => {
			throw new Error("should refuse");
		},
		async (error: unknown) => {
			expect(error).toBeInstanceOf(Response);
			expect(
				((await (error as Response).json()) as { error: string }).error,
			).toContain("no log for this job");
		},
	);
});
