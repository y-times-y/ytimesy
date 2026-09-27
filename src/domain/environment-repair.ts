import { z } from "zod";

export const environmentRepairPlan = z.discriminatedUnion("action", [
	z.object({ action: z.literal("retry-install") }).strict(),
	z.object({ action: z.literal("enable-corepack") }).strict(),
	z
		.object({
			action: z.literal("install-packages"),
			packages: z
				.array(
					z.enum([
						"build-essential",
						"python3",
						"pkg-config",
						"cmake",
						"libssl-dev",
						"libffi-dev",
						"python3-venv",
						"python3-dev",
					]),
				)
				.min(1)
				.max(8),
		})
		.strict(),
	z.object({ action: z.literal("blocked") }).strict(),
]);

export type EnvironmentRepairPlan = z.infer<typeof environmentRepairPlan>;

/** Model output is a capability selection, never executable shell text. */
export function parseEnvironmentRepairPlan(
	text: string,
): EnvironmentRepairPlan {
	return environmentRepairPlan.parse(JSON.parse(text));
}
