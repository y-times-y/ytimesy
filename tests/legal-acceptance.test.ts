import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	CURRENT_LEGAL_VERSIONS,
	legalAcceptanceCurrent,
} from "../src/domain/legal-acceptance";
import {
	legalAcceptanceFor,
	recordLegalAcceptance,
} from "../src/server/adapters/legal-acceptance";

let db: PGlite;
const query = async (sql: string, params?: unknown[]) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query }),
}));

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of [
		"20260913193000_identity_and_projects.sql",
		"20261019140000_legal_acceptance.sql",
	])
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
	await db.exec(
		`insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true)`,
	);
});
afterAll(() => db.close());

it("asks again when either document has a newer version", () => {
	const current = { termsVersion: "t2", privacyVersion: "p2" };
	expect(legalAcceptanceCurrent(null, current)).toBe(false);
	expect(
		legalAcceptanceCurrent(
			{ termsVersion: "t1", privacyVersion: "p2" },
			current,
		),
	).toBe(false);
	expect(
		legalAcceptanceCurrent(
			{ termsVersion: "t2", privacyVersion: "p1" },
			current,
		),
	).toBe(false);
	expect(legalAcceptanceCurrent(current, current)).toBe(true);
});

it("records the accepted versions and time, and replaces them on re-acceptance", async () => {
	expect(await legalAcceptanceFor("alice")).toBeNull();
	await recordLegalAcceptance("alice", "signup");
	const first = await legalAcceptanceFor("alice");
	expect(first).toMatchObject(CURRENT_LEGAL_VERSIONS);
	expect(legalAcceptanceCurrent(first)).toBe(true);
	await db.query(
		"update legal_acceptance set terms_version='old', accepted_at=now()-interval '1 day' where user_id='alice'",
	);
	expect(legalAcceptanceCurrent(await legalAcceptanceFor("alice"))).toBe(false);
	await recordLegalAcceptance("alice", "prompt");
	const second = await db.query<{ terms_version: string; source: string }>(
		"select terms_version,source,accepted_at>now()-interval '1 minute' as fresh from legal_acceptance where user_id='alice'",
	);
	expect(second.rows).toEqual([
		{
			terms_version: CURRENT_LEGAL_VERSIONS.termsVersion,
			source: "prompt",
			fresh: true,
		},
	]);
});

it("is deleted with the account", async () => {
	await db.query("delete from auth_user where id='alice'");
	expect((await db.query("select 1 from legal_acceptance")).rows).toHaveLength(
		0,
	);
});
