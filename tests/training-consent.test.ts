import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TRAINING_POLICY_VERSION } from "../src/content/legal/versions";
import { turnTrainingEligible } from "../src/domain/training-consent";
import { deleteAccountRecords } from "../src/server/adapters/account-deletion";
import {
	dismissTrainingPrompt,
	projectTrainingExcluded,
	setProjectTrainingExcluded,
	setTrainingConsent,
	trainingConsentFor,
	trainingEligibleAtTurnStart,
	trainingPromptDue,
} from "../src/server/adapters/training-consent";

let db: PGlite;
const query = async (sql: string, params?: unknown[]) => {
	const result = await db.query(sql, params);
	return { ...result, rowCount: result.affectedRows ?? result.rows.length };
};
vi.mock("../src/server/adapters/database", () => ({
	database: () => ({ query, connect: async () => ({ query, release() {} }) }),
}));

const project = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000005";
const workspace = "00000000-0000-4000-8000-000000000002";
const session = "00000000-0000-4000-8000-000000000003";
const otherSession = "00000000-0000-4000-8000-000000000006";

beforeAll(async () => {
	db = new PGlite();
	await db.exec("create role anon; create role authenticated;");
	for (const file of (await readdir("supabase/migrations")).sort())
		await db.exec(await readFile(`supabase/migrations/${file}`, "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
	await db.exec(`
		delete from auth_user;
		insert into auth_user(id,name,email,"emailVerified") values('alice','Alice','alice@example.test',true);
		insert into project(id,user_id,repository_id,installation_id,full_name,branch) values('${project}','alice',1,1,'alice/app','main'),('${other}','alice',2,1,'alice/lib','main');
		insert into workspace(id,user_id,project_id,status) values('${workspace}','alice','${project}','ready');
		insert into agent_session(id,user_id,project_id,workspace_id,harness,status) values('${session}','alice','${project}','${workspace}','api','ready'),('${otherSession}','alice','${other}','${workspace}','api','ready');
	`);
});

async function turnTimeEligibility(sessionId: string) {
	return (
		await db.query<{ eligible: boolean }>(
			`select ${trainingEligibleAtTurnStart("$1", "$2")} as eligible`,
			["alice", sessionId],
		)
	).rows[0].eligible;
}

async function insertTurn(sessionId: string, eligible: boolean) {
	await db.query(
		`insert into api_turn(id,session_id,user_id,model_id,connection_revision,state,training_eligible)
		 values(gen_random_uuid(),$1,'alice','m','r','completed',$2)`,
		[sessionId, eligible],
	);
}

it("is off by default for every account and project", async () => {
	expect(await trainingConsentFor("alice")).toEqual({
		enabled: false,
		policyVersion: null,
		changedAt: null,
	});
	expect(await projectTrainingExcluded("alice", project)).toBe(false);
	expect(
		await turnTrainingEligible({
			consentEnabled: false,
			projectExcluded: false,
		}),
	).toBe(false);
	expect(
		await turnTrainingEligible({ consentEnabled: true, projectExcluded: true }),
	).toBe(false);
	expect(
		await turnTrainingEligible({
			consentEnabled: true,
			projectExcluded: false,
		}),
	).toBe(true);
	expect(await turnTimeEligibility(session)).toBe(false);
});

it("audits every change and withdraws earlier turns when turned off", async () => {
	await setTrainingConsent("alice", true, "settings");
	expect(await trainingConsentFor("alice")).toMatchObject({
		enabled: true,
		policyVersion: TRAINING_POLICY_VERSION,
	});
	expect(await turnTimeEligibility(session)).toBe(true);
	await insertTurn(session, true);
	await setTrainingConsent("alice", false, "settings");
	expect((await trainingConsentFor("alice")).enabled).toBe(false);
	expect(
		(await db.query("select training_eligible from api_turn")).rows,
	).toEqual([{ training_eligible: false }]);
	expect(
		(
			await db.query(
				"select enabled,policy_version,source from training_consent_event where user_id='alice' order by created_at,enabled desc",
			)
		).rows,
	).toEqual([
		{
			enabled: true,
			policy_version: TRAINING_POLICY_VERSION,
			source: "settings",
		},
		{
			enabled: false,
			policy_version: TRAINING_POLICY_VERSION,
			source: "settings",
		},
	]);
	await expect(db.query("delete from training_consent_event")).rejects.toThrow(
		"append-only",
	);
	await expect(
		db.query("update training_consent_event set enabled=true"),
	).rejects.toThrow("append-only");
});

it("lets a project only exclude itself, withdrawing its own turns", async () => {
	await setTrainingConsent("alice", true, "settings");
	await insertTurn(session, true);
	await insertTurn(otherSession, true);
	await setProjectTrainingExcluded("alice", project, true);
	expect(await projectTrainingExcluded("alice", project)).toBe(true);
	expect(await turnTimeEligibility(session)).toBe(false);
	expect(await turnTimeEligibility(otherSession)).toBe(true);
	const turns = await db.query<{
		session_id: string;
		training_eligible: boolean;
	}>("select session_id,training_eligible from api_turn order by session_id");
	expect(turns.rows).toEqual([
		{ session_id: session, training_eligible: false },
		{ session_id: otherSession, training_eligible: true },
	]);
	// Including the project again does not make earlier turns eligible.
	await setProjectTrainingExcluded("alice", project, false);
	expect(
		(
			await db.query(
				"select training_eligible from api_turn where session_id=$1",
				[session],
			)
		).rows,
	).toEqual([{ training_eligible: false }]);
	await expect(
		setProjectTrainingExcluded("bob", project, true),
	).rejects.toBeInstanceOf(Response);
});

it("records withdrawal when the account is deleted, and the proof survives it", async () => {
	await setTrainingConsent("alice", true, "settings");
	await deleteAccountRecords("alice");
	expect((await db.query("select 1 from training_consent")).rows).toHaveLength(
		0,
	);
	const events = await db.query<{ enabled: boolean; source: string }>(
		"select enabled,source from training_consent_event where user_id='alice' order by created_at desc limit 1",
	);
	expect(events.rows).toEqual([{ enabled: false, source: "account-deletion" }]);
});

it("shows the training card once to an account that never chose, and Continue records the choice", async () => {
	expect(await trainingPromptDue("alice")).toBe(true);
	await setTrainingConsent("alice", true, "onboarding");
	expect(await trainingPromptDue("alice")).toBe(false);
	expect(await trainingConsentFor("alice")).toMatchObject({
		enabled: true,
		policyVersion: TRAINING_POLICY_VERSION,
	});
	expect(
		(
			await db.query(
				"select enabled,source from training_consent_event where user_id='alice' and source='onboarding'",
			)
		).rows,
	).toEqual([{ enabled: true, source: "onboarding" }]);
});

it("closing the card records no consent, keeps it off and does not show it again", async () => {
	expect(await trainingPromptDue("alice")).toBe(true);
	await dismissTrainingPrompt("alice");
	await dismissTrainingPrompt("alice");
	expect(await trainingPromptDue("alice")).toBe(false);
	expect(await trainingConsentFor("alice")).toEqual({
		enabled: false,
		policyVersion: null,
		changedAt: null,
	});
	expect(await turnTimeEligibility(session)).toBe(false);
	// Settings still turns it on afterwards.
	await setTrainingConsent("alice", true, "settings");
	expect(await turnTimeEligibility(session)).toBe(true);
});
