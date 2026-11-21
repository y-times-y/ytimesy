import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	loadAccountSecrets,
	saveAccountSecret,
	setSecretDescription,
} from "./project-secrets";

const holder = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./database", () => ({ database: () => holder }));

const MIGRATION = readFileSync(
	new URL(
		"../../../supabase/migrations/20261121120000_secret_description.sql",
		import.meta.url,
	),
	"utf8",
);

let db: PGlite;
beforeEach(async () => {
	db = new PGlite();
	// The tables as they were before the migration; the migration itself is applied here.
	await db.exec(`create table project(id uuid primary key, user_id text not null);
	 create table project_secret(id uuid primary key, project_id uuid, name text not null, hint text not null,
	  kind text not null default 'runtime', updated_at timestamptz default now(), unique(project_id, name));
	 create table account_secret(id uuid primary key, user_id text not null, name text not null, hint text not null,
	  encrypted_iv text not null default 'i', encrypted_tag text not null default 't',
	  encrypted_ciphertext text not null default 'c', encrypted_version smallint not null default 1,
	  kind text not null default 'runtime', updated_at timestamptz default now(), unique(user_id, name));
	 insert into project values ('00000000-0000-4000-8000-000000000001','u');
	 insert into project_secret(id, project_id, name, hint) values
	  ('00000000-0000-4000-8000-0000000000a1','00000000-0000-4000-8000-000000000001','OWN','••••1');
	 insert into account_secret(id, user_id, name, hint) values
	  ('00000000-0000-4000-8000-0000000000b1','u','SHARED','••••2');`);
	await db.exec(MIGRATION);
	holder.query.mockImplementation(async (sql: string, values: unknown[]) => {
		const result = await db.query(sql, values);
		return { ...result, rowCount: result.affectedRows || result.rows.length };
	});
});
afterEach(() => db.close());

const PROJECT = "00000000-0000-4000-8000-000000000001";

it("the migration is additive and re-runnable", async () => {
	await db.exec(MIGRATION);
	const columns = await db.query(
		"select table_name from information_schema.columns where column_name='description' and table_name in ('project_secret','account_secret') order by 1",
	);
	expect(columns.rows).toEqual([
		{ table_name: "account_secret" },
		{ table_name: "project_secret" },
	]);
});

it("saves a description on the project's secret, or on the account-wide one, and nothing else", async () => {
	expect(
		await setSecretDescription({
			userId: "u",
			projectId: PROJECT,
			name: "OWN",
			description: "A.",
		}),
	).toBe("project");
	expect(
		await setSecretDescription({
			userId: "u",
			projectId: PROJECT,
			name: "SHARED",
			description: "B.",
		}),
	).toBe("account");
	expect(
		await setSecretDescription({
			userId: "u",
			projectId: PROJECT,
			name: "NOPE",
			description: "C.",
		}),
	).toBeNull();
	// Another user's project and account are untouched.
	expect(
		await setSecretDescription({
			userId: "other",
			projectId: PROJECT,
			name: "OWN",
			description: "D.",
		}),
	).toBeNull();
	expect((await loadAccountSecrets("u"))[0]?.description).toBe("B.");
});

it("a new value for the secret clears its description", async () => {
	await setSecretDescription({
		userId: "u",
		projectId: PROJECT,
		name: "SHARED",
		description: "B.",
	});
	await saveAccountSecret({
		userId: "u",
		name: "SHARED",
		kind: "runtime",
		hint: "••••3",
		encrypted: { version: 1, iv: "i2", tag: "t2", ciphertext: "c2" },
	});
	expect((await loadAccountSecrets("u"))[0]?.description).toBeUndefined();
});
