import { z } from "zod";

const command = z.string().trim().min(1).max(16_384);
export const environmentService = z
	.object({
		name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
		command,
		port: z.number().int().min(1024).max(65535),
		timeoutSeconds: z.number().int().min(1).max(300).default(60),
	})
	.strict();

export const environmentRecipe = z
	.object({
		version: z.literal(1).default(1),
		install: command.optional(),
		buildSecrets: z
			.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/))
			.max(100)
			.default([]),
		verify: z.array(command).max(20).default([]),
		checks: z.array(command).max(20).default([]),
		services: z.array(environmentService).max(12).default([]),
		timeoutSeconds: z.number().int().min(1).max(3600).default(900),
	})
	.strict()
	.superRefine((recipe, ctx) => {
		if (
			new Set(recipe.services.map((service) => service.name)).size !==
			recipe.services.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Service names must be unique.",
			});
		if (
			new Set(recipe.services.map((service) => service.port)).size !==
			recipe.services.length
		)
			ctx.addIssue({
				code: "custom",
				message: "Service ports must be unique.",
			});
	});

export type EnvironmentRecipe = z.infer<typeof environmentRecipe>;
export const ENVIRONMENT_RECIPE_PATH = ".ytimesy/environment.json";

export function parseEnvironmentRecipe(contents: string): EnvironmentRecipe {
	return environmentRecipe.parse(JSON.parse(contents));
}
