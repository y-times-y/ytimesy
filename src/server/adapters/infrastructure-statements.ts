import {
	type InfrastructureStatement,
	infrastructureStatementSchema,
} from "#/domain/infrastructure-statement";
import { requireInfrastructureAdmin } from "../auth/infrastructure-admin";
import { database } from "./database";

/** Immutable, idempotent imports. Overlapping finalized periods cannot be double-counted. */
export async function importInfrastructureStatement(
	actorId: string,
	input: InfrastructureStatement,
) {
	requireInfrastructureAdmin(actorId);
	const statement = infrastructureStatementSchema.parse(input);
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query("select pg_advisory_xact_lock(81738420)");
		const existing = await client.query<{ statement: InfrastructureStatement }>(
			"select statement from infrastructure_provider_statement where provider=$1 and account_id=$2 and source_id=$3",
			[statement.provider, statement.accountId, statement.sourceId],
		);
		if (existing.rows[0]) {
			const recorded = infrastructureStatementSchema.parse(
				existing.rows[0].statement,
			);
			if (JSON.stringify(recorded) !== JSON.stringify(statement))
				throw new Error(
					"That statement was already imported with different charges.",
				);
		} else {
			const overlap = await client.query(
				"select 1 from infrastructure_provider_statement where provider=$1 and account_id=$2 and period_start<$4::timestamptz and period_end>$3::timestamptz limit 1",
				[
					statement.provider,
					statement.accountId,
					statement.periodStart,
					statement.periodEnd,
				],
			);
			if (overlap.rowCount)
				throw new Error(
					"This period overlaps a previously imported statement.",
				);
			await client.query(
				"insert into infrastructure_provider_statement(provider,account_id,source_id,period_start,period_end,statement,imported_by) values($1,$2,$3,$4,$5,$6,$7)",
				[
					statement.provider,
					statement.accountId,
					statement.sourceId,
					statement.periodStart,
					statement.periodEnd,
					JSON.stringify(statement),
					actorId,
				],
			);
		}
		await client.query("commit");
		return statement;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function recentInfrastructureStatements() {
	const result = await database().query<{
		statement: InfrastructureStatement;
		imported_at: Date;
		/** Null once the importing admin deleted their account. */
		imported_by: string | null;
	}>(
		"select statement,imported_at,imported_by from infrastructure_provider_statement order by period_end desc,imported_at desc limit 24",
	);
	return result.rows.map((row) => ({
		statement: infrastructureStatementSchema.parse(row.statement),
		importedAt: row.imported_at.toISOString(),
		importedBy: row.imported_by,
	}));
}
