// Rehearsal database: a throwaway local Postgres in Docker with every
// committed migration applied (supabase/migrations, in order, the way
// scripts/db-migrate.ts applies them), so turns, sessions, receipts and job
// rows go through the real SQL. Never a hosted database: the URL is always
// 127.0.0.1.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";

export const DB_CONTAINER = "ytimesy-rehearsal-db";
const PORT = 55432;
const USER = "rehearsal";
const PASSWORD = "rehearsal";

const docker = (args: string[]) =>
	execFileSync("docker", args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();

/** Supabase's roles, which the migrations grant to and revoke from. */
const SUPABASE_ROLES = ["anon", "authenticated", "service_role"];

/**
 * A fresh database for one rehearsal (the container is reused; the
 * database is dropped and recreated). Returns its URL.
 */
export async function freshDatabase(root: string, name = "rehearsal") {
	if (!/^[a-z_][a-z0-9_]*$/.test(name))
		throw new Error("Invalid rehearsal database name.");
	const running = (() => {
		try {
			return docker(["inspect", "-f", "{{.State.Running}}", DB_CONTAINER]);
		} catch {
			return "";
		}
	})();
	if (running !== "true") {
		if (running) docker(["rm", "-f", DB_CONTAINER]);
		docker([
			"run",
			"-d",
			"--name",
			DB_CONTAINER,
			"-e",
			`POSTGRES_PASSWORD=${PASSWORD}`,
			"-e",
			`POSTGRES_USER=${USER}`,
			"-e",
			"POSTGRES_DB=postgres",
			"-p",
			`127.0.0.1:${PORT}:5432`,
			"postgres:17-alpine",
			"-c",
			"max_connections=300",
		]);
	}
	const admin = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/postgres`;
	for (let attempt = 0; ; attempt++) {
		const client = new pg.Client({ connectionString: admin });
		try {
			await client.connect();
			await client.query(`drop database if exists ${name} with (force)`);
			await client.query(`create database ${name}`);
			for (const role of SUPABASE_ROLES)
				await client.query(
					`do $$ begin create role ${role} nologin; exception when duplicate_object then null; end $$`,
				);
			await client.end();
			break;
		} catch (error) {
			await client.end().catch(() => {});
			if (attempt > 30) throw error;
			await delay(500);
		}
	}
	const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${name}`;
	await applyMigrations(url, join(root, "supabase/migrations"));
	return url;
}

async function applyMigrations(url: string, directory: string) {
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		await client.query("create schema if not exists supabase_migrations");
		await client.query(
			"create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)",
		);
		for (const file of readdirSync(directory)
			.filter((entry) => /^\d{14}_.+\.sql$/.test(entry))
			.sort()) {
			const sql = readFileSync(join(directory, file), "utf8");
			await client.query("begin");
			try {
				await client.query(sql);
				await client.query(
					"insert into supabase_migrations.schema_migrations (version, statements, name) values ($1, $2, $3)",
					[file.slice(0, 14), [sql], file.slice(15, -4)],
				);
				await client.query("commit");
			} catch (error) {
				await client.query("rollback");
				throw new Error(`${file} failed: ${(error as Error).message}`);
			}
		}
	} finally {
		await client.end();
	}
}
