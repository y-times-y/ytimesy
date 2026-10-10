import { z } from "zod";

const immutableRevision = z.string().regex(/^[a-f0-9]{40}$/);
const relativePath = z
	.string()
	.min(1)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!path.split("/").includes("..") &&
			!path.includes("\\") &&
			!path.includes("\0"),
		"Use a repository-relative path without traversal",
	);

/** Evaluator-only configuration. Never put verifier files or credentials in the agent prompt. */
export const evaluationProtocolSchema = z
	.object({
		version: z.literal(1),
		phase: z.enum(["development", "holdout"]),
		baseline: immutableRevision,
		modelId: z.string().min(1),
		reasoning: z.string().min(1),
		seed: z.number().int().nonnegative(),
		repetitions: z.number().int().min(1).max(20),
		graderImage: z.string().regex(/^.+@sha256:[a-f0-9]{64}$/),
		// Benchmark tasks declare limits up to eight hours (Terminal-Bench 4).
		limits: z.object({
			durationSeconds: z.number().int().min(30).max(28_800),
			modelRequests: z.number().int().min(1).max(1_000),
			tokens: z.number().int().min(1000).max(200_000_000),
		}),
		tasks: z
			.array(
				z.object({
					id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
					benchmark: z.string().min(1),
					datasetRevision: immutableRevision,
					projectId: z.uuid(),
					repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
					branch: z.string().min(1),
					commit: immutableRevision,
					prompt: z.string().min(1),
					allowedPaths: z.array(relativePath).min(1),
					verifier: z.object({
						command: z.array(z.string().min(1)).min(1),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
					}),
				}),
			)
			.min(1),
	})
	.strict()
	.superRefine((value, context) => {
		if (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length)
			context.addIssue({ code: "custom", message: "Task IDs must be unique" });
	});

export type EvaluationProtocol = z.infer<typeof evaluationProtocolSchema>;
export type EvaluationTask = EvaluationProtocol["tasks"][number];

/** Stable counterbalanced order: repetitions do not become independent task samples. */
export function pairedEvaluationSchedule(protocol: EvaluationProtocol) {
	return protocol.tasks.flatMap((task, index) =>
		Array.from({ length: protocol.repetitions }, (_, repetition) => ({
			task,
			repetition,
			arms:
				(index + repetition + protocol.seed) % 2 === 0
					? (["ytimesy", "native-codex"] as const)
					: (["native-codex", "ytimesy"] as const),
		})),
	);
}
