import { z } from "zod";
import { environmentModel } from "./environment-model";

const reference = z.string().min(1).max(256);
const identity = { id: z.uuid() };
export const backgroundJob = z.discriminatedUnion("kind", [
	z
		.object({
			...identity,
			kind: z.literal("maintenance"),
			action: z.enum([
				"reconcile",
				"supervise",
				"delivery",
				"checkpoints",
				"refresh",
				"infrastructure",
				"memory-dreams",
				"evidence-expiry",
				"archive-expiry",
			]),
		})
		.strict(),
	z.object({ ...identity, kind: z.literal("model-admission") }).strict(),
	z
		.object({
			...identity,
			kind: z.literal("prepare"),
			workspaceId: reference,
			force: z.boolean().default(true),
			repairModel: environmentModel.nullable(),
		})
		.strict(),
	z
		.object({
			...identity,
			kind: z.literal("task-event"),
			eventId: reference.nullable(),
		})
		.strict(),
	z
		.object({
			...identity,
			kind: z.literal("peer-message"),
			userId: reference,
			senderId: reference,
			recipientId: reference,
			message: z.string().min(1).max(8000),
			fromUser: z.literal(true).optional(),
			context: z.string().max(4000).optional(),
		})
		.strict(),
	z
		.object({
			...identity,
			kind: z.literal("checkpoint"),
			userId: reference,
			sessionId: reference,
		})
		.strict(),
	z.object({ ...identity, kind: z.literal("pr-repair") }).strict(),
	// Messages held for setup, once the workspace's environment is ready.
	z
		.object({
			...identity,
			kind: z.literal("held-sends"),
			workspaceId: reference,
		})
		.strict(),
	// A background command's exit callback (background-exit-wake.ts): one per command.
	z
		.object({
			...identity,
			kind: z.literal("background-wake"),
			userId: reference,
			sessionId: z.uuid(),
			commandId: z.uuid(),
		})
		.strict(),
	// A forked chat's VM, copied after its chat opened (conversation-recovery.ts).
	z
		.object({
			...identity,
			kind: z.literal("conversation-fork"),
			userId: reference,
			sessionId: z.uuid(),
			attempt: z.number().int().positive().max(1000),
		})
		.strict(),
	// Pull request evidence (harness variant prEvidence), after a turn's draft handoff.
	z
		.object({
			...identity,
			kind: z.literal("pr-evidence"),
			userId: reference,
			sessionId: reference,
			revision: z.string().regex(/^refs\/ytimesy\/turn-commits\/[a-f0-9]{64}$/),
			installationId: z.number().int().positive().safe(),
			fullName: z
				.string()
				.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
			pullNumber: z.number().int().positive().safe(),
		})
		.strict(),
	z
		.object({
			...identity,
			kind: z.literal("memory"),
			action: z.enum(["save", "dream"]),
			userId: reference,
			sessionId: reference.optional(),
		})
		.strict(),
]);
export type BackgroundJob = z.infer<typeof backgroundJob>;

/**
 * Kinds whose handler is safe to run again from the top after a restart cut
 * it off mid-way (claims, leases, slug-keyed copies or receipts make a repeat
 * a no-op or a continuation). held-sends (it takes the queued message before
 * starting its turn) and background-wake (it marks the exit notified before
 * waking the agent) are not yet: an interrupted one still fails closed.
 */
const REPLAYABLE_AFTER_INTERRUPTION: ReadonlySet<BackgroundJob["kind"]> =
	new Set([
		"maintenance",
		"model-admission",
		"prepare",
		"task-event",
		"peer-message",
		"checkpoint",
		"pr-repair",
		"conversation-fork",
		"pr-evidence",
		"memory",
	]);
/** A job a deploy keeps interrupting stops being replayed after this many. */
export const MAX_JOB_INTERRUPTIONS = 3;

/** What the job runner does with a job a Worker restart cut off. */
export function interruptedJobDecision(
	kind: BackgroundJob["kind"],
	interruptions: number,
): "replay" | "fail" {
	return REPLAYABLE_AFTER_INTERRUPTION.has(kind) &&
		interruptions < MAX_JOB_INTERRUPTIONS
		? "replay"
		: "fail";
}
