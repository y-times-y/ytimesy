import { z } from "zod";

const fact = z.string().trim().min(1).max(400);
export const projectContextPacket = z.object({
	capability: fact,
	implementation: z
		.array(z.object({ symbol: fact, responsibility: fact }))
		.min(1)
		.max(4),
	interfaces: z.array(fact).max(4),
	constraints: z.array(fact).max(4),
	verification: z
		.array(
			z.object({
				command: fact,
				scope: fact,
				outcome: z.enum(["not_run", "passed", "failed"]),
			}),
		)
		.max(4),
	unresolved: z.array(fact).max(4),
});

/** Commands remain historical evidence, never auto-executed from a context packet. */
export function renderProjectContextPacket(
	raw: z.infer<typeof projectContextPacket>,
) {
	const packet = projectContextPacket.parse(raw);
	const sections = [
		`Capability: ${packet.capability}`,
		`Existing implementation:\n${packet.implementation.map((item) => `- ${item.symbol}: ${item.responsibility}`).join("\n")}`,
		...(
			[
				["Interfaces", packet.interfaces],
				["Constraints", packet.constraints],
				["Unresolved", packet.unresolved],
			] as const
		)
			.filter(([, facts]) => facts.length)
			.map(
				([title, facts]) =>
					`${title}:\n${facts.map((fact) => `- ${fact}`).join("\n")}`,
			),
		...(packet.verification.length
			? [
					`Verification (agent-reported, not current proof):\n${packet.verification.map((check) => `- ${check.command} — ${check.scope}; ${check.outcome}`).join("\n")}`,
				]
			: []),
	];
	const text = sections.join("\n\n");
	if (text.length > 2000)
		throw new Error("Condense this context packet to at most 2000 characters.");
	return text;
}
