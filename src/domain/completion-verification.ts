import { z } from "zod";

const revision = z.string().regex(/^[a-f0-9]{40,64}$/);
export const completionSnapshot = z.object({
	base: revision,
	tree: revision,
	patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
	changed: z.boolean(),
	policyChanged: z.boolean(),
	recipe: z.string().nullable(),
	manifest: z.string().nullable(),
	files: z.array(z.string()),
});
export const completedVerification = z.object({
	type: z.literal("completion-verification"),
	directory: z.string().min(1),
	turn: z.string().regex(/^[a-f0-9]{64}$/),
	base: revision,
	tree: revision,
	patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
	checks: z
		.array(
			z.object({
				command: z.string().min(1),
				reference: z.uuid(),
				exitCode: z.literal(0),
				stopped: z.null(),
			}),
		)
		.min(1)
		.max(41),
});
export type CompletedVerification = z.infer<typeof completedVerification>;
