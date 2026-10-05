import { z } from "zod";

const microUsd = z.number().int().nonnegative().max(1_000_000_000_000);
const timestamp = z.iso
	.datetime({ offset: true })
	.transform((value) => new Date(value).toISOString());

/** Finalized provider usage, before credits/tax. Unknown categories stay null. */
export const infrastructureStatementSchema = z
	.object({
		provider: z.literal("freestyle"),
		accountId: z.string().regex(/^acct-[A-Za-z0-9-]{1,100}$/),
		sourceId: z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/),
		periodStart: timestamp,
		periodEnd: timestamp,
		computeMicroUsd: microUsd.nullable(),
		diskMicroUsd: microUsd.nullable(),
		snapshotMicroUsd: microUsd.nullable(),
		transferMicroUsd: microUsd.nullable(),
		otherMicroUsd: microUsd.nullable(),
		grossMicroUsd: microUsd,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.periodStart >= value.periodEnd)
			context.addIssue({ code: "custom", message: "Empty billing period." });
		const categories = [
			value.computeMicroUsd,
			value.diskMicroUsd,
			value.snapshotMicroUsd,
			value.transferMicroUsd,
			value.otherMicroUsd,
		];
		const sum = categories.reduce<number>(
			(total, cost) => total + (cost ?? 0),
			0,
		);
		if (
			sum > value.grossMicroUsd ||
			(categories.every((cost) => cost !== null) && sum !== value.grossMicroUsd)
		)
			context.addIssue({
				code: "custom",
				message: "Category charges do not reconcile to the gross total.",
			});
	});

export type InfrastructureStatement = z.infer<
	typeof infrastructureStatementSchema
>;

export function statementCostCoverage(statement: InfrastructureStatement) {
	return {
		snapshotChargesKnown: statement.snapshotMicroUsd !== null,
		transferChargesKnown: statement.transferMicroUsd !== null,
		unclassifiedMicroUsd:
			statement.grossMicroUsd -
			(statement.computeMicroUsd ?? 0) -
			(statement.diskMicroUsd ?? 0) -
			(statement.snapshotMicroUsd ?? 0) -
			(statement.transferMicroUsd ?? 0) -
			(statement.otherMicroUsd ?? 0),
	};
}
