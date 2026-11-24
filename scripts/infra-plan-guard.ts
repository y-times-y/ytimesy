/**
 * What an infrastructure plan may do before scripts/infra.ts applies it.
 * Alchemy's own `RemovalPolicy.protect()` already refuses deleting or
 * replacing the declared stateful resources; this is the second lock, read
 * from the plan Alchemy prints, so a change to the stack (a renamed logical
 * id, a dropped protect) still cannot remove or recreate anything.
 */

/** Resources that already exist in production and must never be created anew. */
export const EXISTING_IN_PRODUCTION = [
	"Edge",
	"Web",
	"BoxRole",
	"BoxProfile",
	"BoxSecurityGroup",
	"BoxFleet",
] as const;

export type PlanRow = {
	readonly resource: string;
	readonly action: string;
};

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The `[Resource] action` rows of `alchemy plan` output (bindings included). */
export function planRows(output: string): PlanRow[] {
	const rows: PlanRow[] = [];
	for (const line of output.replace(ANSI, "").split("\n")) {
		const match = line.match(
			/\[([^\]]+)\] (create|update|adopted|replace|delete|orphaned|unbind|noop)\b/,
		);
		if (match) rows.push({ resource: match[1], action: match[2] });
	}
	return rows;
}

/** Why the plan must not be applied; empty when it may. */
export function planProblems(input: {
	readonly output: string;
	readonly stage: "development" | "production";
	readonly adopting: boolean;
}): string[] {
	const text = input.output.replace(ANSI, "");
	const summary = text.match(/Plan: (.*)/)?.[1];
	if (summary === undefined)
		return [
			"The plan printed no summary line; refusing to apply what was not shown.",
		];
	const problems: string[] = [];
	for (const row of planRows(text)) {
		if (["replace", "delete", "orphaned"].includes(row.action))
			problems.push(
				`${row.resource} would be ${row.action === "orphaned" ? "orphaned" : `${row.action}d`}.`,
			);
		else if (row.action === "unbind")
			problems.push(`${row.resource} would lose a binding.`);
		else if (row.action === "adopted" && !input.adopting)
			problems.push(
				`${row.resource} would be adopted without --adopt-existing.`,
			);
		else if (
			row.action === "create" &&
			input.stage === "production" &&
			(EXISTING_IN_PRODUCTION as readonly string[]).includes(row.resource)
		)
			problems.push(
				`${row.resource} exists in production but the plan would create it (its read or adoption failed).`,
			);
	}
	return problems;
}
