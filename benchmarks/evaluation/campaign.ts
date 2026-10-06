import { createHash } from "node:crypto";
import { z } from "zod";
import {
	evaluationProtocolSchema,
	pairedEvaluationSchedule,
} from "#/domain/harness-evaluation";

export const campaignCategories = [
	"navigation",
	"repair",
	"multi-file",
	"verification",
	"coordination",
	"long-context",
] as const;

/** Development sampling guard, not a statistical power calculation or a parity decision. */
export const evaluationCampaignSchema = z
	.object({
		version: z.literal(1),
		harnessRevision: z.string().regex(/^[a-f0-9]{40}$/),
		protocol: evaluationProtocolSchema,
		assignments: z.array(
			z.object({ taskId: z.string(), category: z.enum(campaignCategories) }),
		),
	})
	.strict()
	.superRefine((campaign, context) => {
		const { protocol, assignments } = campaign;
		const reject = (message: string) =>
			context.addIssue({ code: "custom", message });
		if (protocol.phase !== "development")
			reject(
				"This campaign guard is development-only. Holdout sample size and non-inferiority margins need separate agreement.",
			);
		if (protocol.tasks.length < 12)
			reject(
				"A representative development campaign needs at least twelve distinct tasks.",
			);
		if (protocol.repetitions < 2)
			reject(
				"Counterbalanced development comparisons need at least two repetitions per task.",
			);
		if (new Set(protocol.tasks.map((task) => task.repository)).size < 3)
			reject(
				"Use at least three repositories; one known project is not a representative campaign.",
			);
		const assigned = new Map(
			assignments.map((entry) => [entry.taskId, entry.category]),
		);
		if (
			assigned.size !== assignments.length ||
			assigned.size !== protocol.tasks.length ||
			protocol.tasks.some((task) => !assigned.has(task.id))
		)
			reject(
				"Each protocol task needs exactly one category; missing, duplicate or extraneous assignments are rejected.",
			);
		for (const category of campaignCategories)
			if (assignments.filter((entry) => entry.category === category).length < 2)
				reject(`Category ${category} needs at least two independent tasks.`);
		const problems = protocol.tasks.map((task) =>
			JSON.stringify([task.repository, task.commit, task.prompt]),
		);
		if (new Set(problems).size !== problems.length)
			reject(
				"Renaming or repeating the same repository, commit and prompt does not create an independent task.",
			);
	});

export function inspectEvaluationCampaign(raw: unknown) {
	const campaign = evaluationCampaignSchema.parse(raw);
	const schedule = pairedEvaluationSchedule(campaign.protocol);
	return {
		campaign,
		sha256: createHash("sha256").update(JSON.stringify(campaign)).digest("hex"),
		independentTasks: campaign.protocol.tasks.length,
		pairedAttempts: schedule.length,
		armAttempts: schedule.length * 2,
		maximumSequentialArmSeconds:
			schedule.length * 2 * campaign.protocol.limits.durationSeconds,
		productionObservedTokenThresholdTotal:
			schedule.length * campaign.protocol.limits.tokens,
		productionRequestLimitTotal:
			schedule.length * campaign.protocol.limits.modelRequests,
		status: "prepared-not-executed" as const,
		limitations: [
			"Category balance is a development sampling rule, not proof of representativeness or statistical power.",
			"Local revision availability does not verify the deployed worker revision or its guard configuration.",
			"Native control request/token limits are not equivalent; observed token thresholds are not dollar caps.",
			"No result, superiority claim or deployment approval follows from preflight.",
		],
	};
}
