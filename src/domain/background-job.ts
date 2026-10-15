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
