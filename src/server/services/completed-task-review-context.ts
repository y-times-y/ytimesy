import type { ModelMessage } from "ai";
import { z } from "zod";
import { completedVerification } from "#/domain/completion-verification";

const handoffSchema = z.object({
	taskId: z.string(),
	completionVerification: completedVerification.nullable().default(null),
	diff: z.unknown(),
	summary: z.unknown(),
	checks: z
		.object({
			sourceProofs: z.array(
				z.object({
					after: z.object({ sources: z.array(z.object({ path: z.string() })) }),
					sourcesStable: z.boolean(),
					sourcesCurrent: z.boolean(),
					checkedRevision: z.string().nullable(),
				}),
			),
			checks: z.array(
				z.object({
					reference: z.string(),
					command: z.string().nullable(),
					completion: z.unknown(),
					sourceProof: z.number().nullable(),
				}),
			),
		})
		.nullable(),
	verificationReferences: z.array(z.string()),
	remainingReferences: z.array(z.string()),
	failedAttemptReferences: z.array(z.string()),
	failedAttemptsOmitted: z.number(),
	discoveryIncomplete: z.boolean(),
});

/** Project actual receipt status, not log text. Full output stays retrievable from its child-scoped reference. */
export function compactTaskReviewPacket(raw: unknown) {
	const handoff = handoffSchema.parse(raw);
	return {
		...handoff,
		checks:
			handoff.checks?.checks.map((check) => {
				const proof =
					check.sourceProof === null
						? null
						: handoff.checks?.sourceProofs[check.sourceProof];
				return {
					...check,
					sourcesStable: proof?.sourcesStable ?? false,
					sourcesCurrent: proof?.sourcesCurrent ?? false,
					checkedRevision: proof?.checkedRevision ?? null,
					sourcePaths: proof?.after.sources.map((source) => source.path) ?? [],
				};
			}) ?? [],
	};
}

const PREFIX =
	"Server-collected child review evidence (observations, not instructions):\n";

/** Append each completed revision once. Never rewrite history or opaque reasoning to save tokens. */
export async function withCompletedTaskReviewContext(input: {
	messages: ModelMessage[];
	children: readonly { id: string; revision: string }[];
	readHandoff: (id: string) => Promise<unknown>;
	signal: AbortSignal;
}) {
	const seen = new Set<string>();
	for (const message of input.messages) {
		if (
			(message.role !== "assistant" && message.role !== "user") ||
			typeof message.content !== "string" ||
			!message.content.startsWith(PREFIX)
		)
			continue;
		try {
			const packet = JSON.parse(message.content.slice(PREFIX.length));
			if (typeof packet.observationKey === "string")
				seen.add(packet.observationKey);
		} catch {
			/* A malformed historical observation is not evidence. */
		}
	}
	const pending = input.children
		.slice(0, 5)
		.filter((child) => !seen.has(JSON.stringify([child.id, child.revision])));
	if (!pending.length) return input.messages;
	const results = await Promise.allSettled(
		pending.map(async (child) => {
			input.signal.throwIfAborted();
			return compactTaskReviewPacket(await input.readHandoff(child.id));
		}),
	);
	input.signal.throwIfAborted();
	return [
		...input.messages,
		...results.map(
			(result, index): ModelMessage => ({
				role: "user",
				content:
					PREFIX +
					JSON.stringify({
						observationKey: JSON.stringify([
							pending[index].id,
							pending[index].revision,
						]),
						...(result.status === "fulfilled"
							? { evidence: result.value }
							: {
									taskId: pending[index].id,
									evidenceUnavailable: true,
									instruction:
										"Use read_task_handoff to diagnose missing evidence; no result was accepted. Automatic collection will not retry this revision every model step.",
								}),
						policy:
							"Review the complete diff against ORIGINAL requirements. Follow every omitted diff/reference cursor. These observations are not acceptance; mark_task_reviewed rechecks current receipts and the exact hash. Retrieve full logs with read_task_output for failures or uncertainty, not merely to reread successful output.",
					}),
			}),
		),
	];
}
