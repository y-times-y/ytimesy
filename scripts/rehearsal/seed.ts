// Rows a hard-set run needs, in the rehearsal database: the subscription
// owner (a connected Codex login whose token never expires during the
// rehearsal, so nothing refreshes it over the network), the owner's project
// (y-times-y/ytimesy, as on development) and, per scenario, an eval user
// with the rows scripts/smoke/eval-user.ts createEvalUser inserts, and the
// task chat the hard-set runner opens and sends (scripts/hard-set.ts
// provision + startTurn).
import { randomUUID } from "node:crypto";
import {
	type HarnessVariant,
	harnessVariantChanges,
} from "../../src/domain/harness-variant";
import { WorkspaceId } from "../../src/domain/ids";
import {
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../../src/server/adapters/agent-sessions";
import {
	saveAttemptLoopDeadline,
	saveTurnDeadline,
} from "../../src/server/adapters/attempt-loop-store";
import {
	backgroundJobId,
	dispatchBackgroundJob,
} from "../../src/server/adapters/background-job-dispatch";
import { database } from "../../src/server/adapters/database";
import { seal } from "../../src/server/auth/token-vault";
import { sendSubscriptionTask } from "../../src/server/services/codex-subscription-session";

export const MODEL = "gpt-6.1-sol";

const LISTED = ["gpt-6.1-sol", "gpt-6-luna"].map((id) => ({
	id,
	label: id,
	reasoning: {
		levels: [
			{ id: "low", label: "Low" },
			{ id: "medium", label: "Medium" },
			{ id: "high", label: "High" },
		],
		defaultLevelId: "medium",
	},
}));

function codexLogin(accountId: string) {
	const part = (value: object) =>
		Buffer.from(JSON.stringify(value)).toString("base64url");
	return JSON.stringify({
		auth_mode: "chatgpt",
		tokens: {
			access_token: `${part({ alg: "none" })}.${part({ exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 })}.rehearsal`,
			refresh_token: "rehearsal-refresh-never-used",
			account_id: accountId,
		},
	});
}

export async function seedOwner() {
	const db = database();
	const ownerId = `owner-${randomUUID().slice(0, 8)}`;
	await db.query(
		`insert into auth_user(id,name,email,"emailVerified") values($1,'Rehearsal owner',$2,true)`,
		[ownerId, `${ownerId}@rehearsal.invalid`],
	);
	await db.query(
		`insert into agent_account(user_id,provider,status,plan_type,updated_at,encrypted_codex_auth)
		 values($1,'codex','connected','pro',now(),$2)`,
		[ownerId, await seal(codexLogin("rehearsal-account"))],
	);
	await db.query(
		"insert into agent_model_catalog(user_id,provider,models,updated_at) values($1,'codex',$2::jsonb,now())",
		[ownerId, JSON.stringify(LISTED)],
	);
	const projectId = randomUUID();
	await db.query(
		`insert into project(id,user_id,repository_id,installation_id,full_name,branch,name)
		 values($1,$2,1001,2002,'y-times-y/ytimesy','main','ytimesy')`,
		[projectId, ownerId],
	);
	const workspaceId = randomUUID();
	await db.query(
		// Development's owner workspace has a prepared template snapshot; task
		// chats never copy it (their session already names its VM).
		"insert into workspace(id,user_id,project_id,status,template_snapshot_id) values($1,$2,$3,'ready','sc-rehearsal-template')",
		[workspaceId, ownerId, projectId],
	);
	return { ownerId, projectId, workspaceId };
}

export type RehearsalUser = {
	userId: string;
	projectId: string;
	workspaceId: string;
	variant: HarnessVariant;
};

/** createEvalUser's rows (eval-user.ts), against the rehearsal owner. */
export async function createRehearsalUser(
	owner: Awaited<ReturnType<typeof seedOwner>>,
	label: string,
	variant: HarnessVariant,
): Promise<RehearsalUser> {
	const db = database();
	const userId = `eval-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
	await db.query(
		`insert into auth_user(id,name,email,"emailVerified") values($1,$2,$3,true)`,
		[userId, `Eval ${label}`, `${userId}@ytimesy-eval.invalid`],
	);
	await db.query(
		"insert into dev_eval_user(user_id,owner_user_id,label,harness_variant) values($1,$2,$3,$4::jsonb)",
		[
			userId,
			owner.ownerId,
			label,
			JSON.stringify(harnessVariantChanges(variant)),
		],
	);
	await db.query(
		"insert into infrastructure_usage_policy(user_id,monthly_micro_usd) values($1,$2)",
		[userId, 50_000_000],
	);
	// A placeholder login: turns resolve the owner's (codexCredentialUserId).
	await db.query(
		`insert into agent_account(user_id,provider,status,plan_type,updated_at,encrypted_codex_auth)
		 values($1,'codex','connected','pro',now(),$2)`,
		[userId, await seal(codexLogin("eval-user-delegates-to-owner"))],
	);
	await db.query(
		`insert into agent_model_catalog(user_id,provider,models,updated_at)
		 select $1,provider,models,updated_at from agent_model_catalog where user_id=$2`,
		[userId, owner.ownerId],
	);
	await db.query(
		`insert into user_memory(user_id,mode,repo,dreamed_through) values($1,'off',$2,now())`,
		[userId, `memory-${userId}`],
	);
	const projectId = randomUUID();
	const workspaceId = randomUUID();
	await db.query(
		`insert into project select (jsonb_populate_record(null::project,
			to_jsonb(p) || jsonb_build_object('id', $2::uuid, 'user_id', $3::text, 'repository_id', $4::bigint, 'created_at', now()))).*
		 from project p where p.id=$1`,
		[
			owner.projectId,
			projectId,
			userId,
			9_000_000_000 + Math.floor(Math.random() * 1e9),
		],
	);
	await db.query(
		`insert into workspace select (jsonb_populate_record(null::workspace,
			to_jsonb(w) || jsonb_build_object('id', $2::uuid, 'project_id', $3::uuid, 'user_id', $4::text,
				'provider_ref', null, 'last_job_id', null, 'created_at', now(), 'updated_at', now()))).*
		 from workspace w where w.id=$1`,
		[owner.workspaceId, workspaceId, projectId, userId],
	);
	return { userId, projectId, workspaceId, variant };
}

/** scripts/hard-set.ts provision (rows) + startTurn, on a prepared VM. */
export async function startTaskChat(input: {
	user: RehearsalUser;
	vm: string;
	text: string;
	agentSeconds: number;
	title: string;
}) {
	const { user } = input;
	const session = await insertAgentSession({
		userId: user.userId,
		projectId: user.projectId,
		workspaceId: user.workspaceId,
		harness: "codex",
		title: input.title,
		listedModelId: MODEL,
	});
	await saveAgentSessionProviderRef(session.id, WorkspaceId(input.vm));
	await database().query(
		"update agent_session set status='ready' where id=$1",
		[session.id],
	);
	const deadline = Date.now() + input.agentSeconds * 1000;
	if (user.variant.review === "on")
		await saveAttemptLoopDeadline(session.id, deadline - 20_000);
	await saveTurnDeadline(session.id, deadline);
	await sendSubscriptionTask(
		{ userId: user.userId, projectId: user.projectId, sessionId: session.id },
		{ modelId: MODEL, text: input.text },
	);
	await dispatchBackgroundJob({
		id: backgroundJobId(`rehearsal-admit:${session.id}`),
		kind: "model-admission",
	});
	return session.id;
}
