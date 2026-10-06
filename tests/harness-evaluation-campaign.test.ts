import { expect, it } from "vitest";
import {
	campaignCategories,
	inspectEvaluationCampaign,
} from "../benchmarks/evaluation/campaign";

function fixture() {
	const tasks = Array.from({ length: 12 }, (_, index) => ({
		id: `task_${index}`,
		benchmark: "operator-independent-development-tasks",
		datasetRevision: "a".repeat(40),
		projectId: "11111111-1111-4111-8111-111111111111",
		repository: `owner/repo-${index % 3}`,
		branch: "main",
		commit: "b".repeat(40),
		prompt: `Solve independent problem ${index}`,
		allowedPaths: [`src/problem-${index}.ts`],
		verifier: {
			command: [`/private/verifier-${index}.cjs`, "node"],
			sha256: "c".repeat(64),
		},
	}));
	return {
		version: 1,
		harnessRevision: "d".repeat(40),
		protocol: {
			version: 1,
			phase: "development",
			baseline: "e".repeat(40),
			modelId: "explicit-model",
			reasoning: "high",
			seed: 0,
			repetitions: 2,
			graderImage: `node@sha256:${"f".repeat(64)}`,
			limits: { durationSeconds: 120, modelRequests: 5, tokens: 10000 },
			tasks,
		},
		assignments: tasks.map((task, index) => ({
			taskId: task.id,
			category: campaignCategories[Math.floor(index / 2)],
		})),
	};
}
it("prepares a counterbalanced fixed-model campaign without declaring an executed result", () => {
	const result = inspectEvaluationCampaign(fixture());
	expect(result).toMatchObject({
		status: "prepared-not-executed",
		independentTasks: 12,
		pairedAttempts: 24,
		armAttempts: 48,
		maximumSequentialArmSeconds: 5760,
	});
	expect(result.campaign.protocol.modelId).toBe("explicit-model");
});
it("rejects one-project pilots, renamed copies, missing categories and holdout execution", () => {
	const oneProject = fixture();
	oneProject.protocol.tasks.forEach((task) => {
		task.repository = "owner/one";
	});
	expect(() => inspectEvaluationCampaign(oneProject)).toThrow(
		"three repositories",
	);
	const copied = fixture();
	copied.protocol.tasks[1] = { ...copied.protocol.tasks[0], id: "task_1" };
	expect(() => inspectEvaluationCampaign(copied)).toThrow("independent task");
	const unassigned = fixture();
	unassigned.assignments.pop();
	expect(() => inspectEvaluationCampaign(unassigned)).toThrow("exactly one");
	const holdout = fixture();
	holdout.protocol.phase = "holdout";
	expect(() => inspectEvaluationCampaign(holdout)).toThrow("development-only");
});
