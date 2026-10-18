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
