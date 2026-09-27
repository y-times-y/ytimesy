import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
	loadAgentModelCatalog,
	saveAgentModelCatalog,
} from "../src/server/adapters/agent-model-catalog";

let db: PGlite;
vi.mock("../src/server/adapters/database", () => ({ database: () => db }));
beforeAll(async () => {
	db = new PGlite();
	await db.exec(`create role anon; create role authenticated;
		create table auth_user(id text primary key);
		create table agent_session(user_id text, harness text, listed_model_id text);
		insert into auth_user values ('alice'),('bob');
		insert into agent_session values ('alice','claude','prior-model'),('alice','claude','prior-model');`);
	await db.exec(
		await readFile(
			"supabase/migrations/20260926140000_agent_model_catalog.sql",
			"utf8",
		),
	);
});
afterAll(async () => {
	await db.close();
});

it("backfills only the owner's previously selected models, without a VM", async () => {
	expect(await loadAgentModelCatalog("alice", "claude")).toEqual([
		{ id: "prior-model", label: "prior-model" },
	]);
	expect(await loadAgentModelCatalog("bob", "claude")).toEqual([]);
	expect(await loadAgentModelCatalog("alice", "codex")).toEqual([]);
});

it("preserves capabilities and does not erase the catalog on disconnect", async () => {
	const models = [
		{ id: "listed", label: "Listed model", supportsFastMode: true },
	];
	await saveAgentModelCatalog("alice", "codex", models);
	await saveAgentModelCatalog("alice", "codex", []);
	expect(await loadAgentModelCatalog("alice", "codex")).toEqual(models);
	expect(await loadAgentModelCatalog("bob", "codex")).toEqual([]);
	await saveAgentModelCatalog("alice", "codex", [
		{ id: "new", label: "New model" },
	]);
	expect(await loadAgentModelCatalog("alice", "codex")).toEqual([
		{ id: "new", label: "New model" },
	]);
});

it("denies direct client access", async () => {
	await db.exec("set role authenticated");
	await expect(db.query("select * from agent_model_catalog")).rejects.toThrow();
	await db.exec("reset role");
});

it("removes a legacy model saved under the wrong provider", async () => {
	await saveAgentModelCatalog("bob", "claude", [
		{ id: "gpt-wrong", label: "Wrong provider" },
	]);
	await db.exec(
		await readFile(
			"supabase/migrations/20260926141000_filter_legacy_model_catalog.sql",
			"utf8",
		),
	);
	expect(await loadAgentModelCatalog("bob", "claude")).toEqual([]);
	expect(await loadAgentModelCatalog("alice", "claude")).toEqual([
		{ id: "prior-model", label: "prior-model" },
	]);
});
