import { z } from "zod";

export const taskVerificationAssignment = z.object({
	commands: z.array(z.string().min(1)).min(1).max(16),
	sourcePaths: z.array(z.string().min(1)).min(1).max(128),
	finalChecks: z.array(z.string().min(1)).min(1).max(8),
});

/** Normalize only unadorned package-script aliases; flags, environment settings and shell composition remain distinct. */
export function verificationCommandIdentity(command: string) {
	const text = command.trim();
	const match = /^(?:corepack\s+)?(pnpm|yarn)\s+(?:run\s+)?([\w:.-]+)$/.exec(
		text,
	);
	return match ? `${match[1]} run ${match[2]}` : text;
}

export function requireAssignedTaskChecks(
	assignment: z.infer<typeof taskVerificationAssignment>,
	checks: readonly { command: string | null; sourcePaths: readonly string[] }[],
) {
	for (const command of assignment.commands) {
		const matching = checks.filter(
			(check) =>
				check.command !== null &&
				verificationCommandIdentity(check.command) ===
					verificationCommandIdentity(command),
		);
		if (
			!matching.length ||
			assignment.sourcePaths.some(
				(path) => !matching.some((check) => check.sourcePaths.includes(path)),
			)
		)
			throw new Error(
				"Assigned verification is missing a command or owned-source binding for a declared verification file; retrieve current complete receipts before acceptance.",
			);
	}
}
