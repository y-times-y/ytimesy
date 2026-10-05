import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	infrastructureStatementSchema,
	statementCostCoverage,
} from "../src/domain/infrastructure-statement";
import {
	importInfrastructureStatement,
	recentInfrastructureStatements,
} from "../src/server/adapters/infrastructure-statements";

let db: PGlite;
const query = async (sql: string, params: unknown[] = []) => {
	const result = await db.query(sql, params);
	return {
		...result,
		rowCount: result.rows.length || result.affectedRows || 0,
	};
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));
const statement = () =>
	infrastructureStatementSchema.parse({
		provider: "freestyle",
		accountId: "acct-test",
		sourceId: "invoice-1",
		periodStart: "2026-09-01T00:00:00Z",
		periodEnd: "2026-10-01T00:00:00Z",
		computeMicroUsd: 30,
		diskMicroUsd: 10,
		snapshotMicroUsd: 0,
		transferMicroUsd: 5,
		otherMicroUsd: 0,
		grossMicroUsd: 45,
	});
beforeAll(async () => {
	db = new PGlite();
	await db.exec(
		"create role anon; create role authenticated; create table auth_user(id text primary key); insert into auth_user values('admin');",
	);
	await db.exec(
		readFileSync(
			"supabase/migrations/20261003025000_infrastructure_statements.sql",
			"utf8",
		),
	);
}, 15_000);
beforeEach(async () => {
	vi.stubEnv("YTIMESY_ADMIN_USER_IDS", "admin");
	await db.exec("truncate infrastructure_provider_statement");
});
afterAll(async () => {
	vi.unstubAllEnvs();
	await db.close();
});

it("distinguishes missing charges from actual zero and rejects invented totals", () => {
	expect(statementCostCoverage(statement()).snapshotChargesKnown).toBe(true);
	expect(
		statementCostCoverage({ ...statement(), snapshotMicroUsd: null })
			.snapshotChargesKnown,
	).toBe(false);
	expect(() =>
		infrastructureStatementSchema.parse({ ...statement(), grossMicroUsd: 44 }),
	).toThrow();
	expect(() =>
		infrastructureStatementSchema.parse({ ...statement(), grossMicroUsd: 46 }),
	).toThrow();
	expect(() =>
		infrastructureStatementSchema.parse({
			...statement(),
			periodEnd: statement().periodStart,
		}),
	).toThrow();
	expect(() =>
		infrastructureStatementSchema.parse({ ...statement(), currency: "EUR" }),
	).toThrow();
});
it("records provenance and safely repeats the same import", async () => {
	await importInfrastructureStatement("admin", statement());
	await importInfrastructureStatement("admin", statement());
	const records = await recentInfrastructureStatements();
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({
		importedBy: "admin",
		statement: statement(),
	});
});
it("rejects conflicting identities and overlapping periods but permits adjacent periods", async () => {
	await importInfrastructureStatement("admin", statement());
	await expect(
		importInfrastructureStatement("admin", {
			...statement(),
			computeMicroUsd: 31,
			grossMicroUsd: 46,
		}),
	).rejects.toThrow("different charges");
	await expect(
		importInfrastructureStatement("admin", {
			...statement(),
			sourceId: "another",
		}),
	).rejects.toThrow("overlaps");
	await importInfrastructureStatement("admin", {
		...statement(),
		sourceId: "next",
		periodStart: "2026-10-01T00:00:00.000Z",
		periodEnd: "2026-11-01T00:00:00.000Z",
	});
	expect(await recentInfrastructureStatements()).toHaveLength(2);
});
it("rejects non-admin imports and browser database access", async () => {
	await expect(
		importInfrastructureStatement("other", statement()),
	).rejects.toMatchObject({ status: 403 });
	await db.exec("set role authenticated");
	try {
		await expect(
			db.query("select * from infrastructure_provider_statement"),
		).rejects.toThrow("permission");
	} finally {
		await db.exec("reset role");
	}
});
