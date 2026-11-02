import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import {
	TRAINING_CONSENT_OFF,
	type TrainingConsent,
} from "#/domain/training-consent";
import { database } from "./database";

/**
 * SQL for api_turn.training_eligible at the moment a turn is queued:
 * turnTrainingEligible() over the owner's consent row (none = off) and the
 * chat's project exclusion. `user` and `session` are parameter placeholders.
 */
export function trainingEligibleAtTurnStart(user: string, session: string) {
	return `coalesce((select c.enabled and not p.training_excluded from training_consent c
		join agent_session s on s.user_id=c.user_id join project p on p.id=s.project_id
		where c.user_id=${user} and s.id=${session}), false)`;
}

export async function trainingConsentFor(
	userId: string,
): Promise<TrainingConsent> {
	const row = (
		await database().query<{
			enabled: boolean;
			policy_version: string;
			changed_at: Date;
		}>(
			"select enabled,policy_version,changed_at from training_consent where user_id=$1",
			[userId],
		)
	).rows[0];
	return row
		? {
				enabled: row.enabled,
				policyVersion: row.policy_version,
				changedAt: new Date(row.changed_at).toISOString(),
			}
		: TRAINING_CONSENT_OFF;
}

/**
 * Sets the account consent and appends the audit event in one transaction.
 * Turning it off also withdraws every earlier turn's eligibility at once.
 */
export async function setTrainingConsent(
	userId: string,
	enabled: boolean,
	source: "settings" | "onboarding",
) {
	const client = await database().connect();
	try {
		await client.query("begin");
		await client.query(
			`insert into training_consent(user_id,enabled,policy_version,source) values($1,$2,$3,$4)
			 on conflict(user_id) do update set enabled=excluded.enabled,policy_version=excluded.policy_version,
			 source=excluded.source,changed_at=now()`,
			[userId, enabled, TRAINING_POLICY_VERSION, source],
		);
		await client.query(
			"insert into training_consent_event(user_id,enabled,policy_version,source) values($1,$2,$3,$4)",
			[userId, enabled, TRAINING_POLICY_VERSION, source],
		);
		if (!enabled)
			await client.query(
				"update api_turn set training_eligible=false where user_id=$1 and training_eligible",
				[userId],
			);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

/**
 * Whether to show the "Help improve ytimesy" card: the account never set
 * consent (no row, so it is off) and never closed the card unanswered.
 */
export async function trainingPromptDue(userId: string) {
	const row = (
		await database().query<{ due: boolean }>(
			`select not exists(select 1 from training_consent where user_id=$1)
			 and not exists(select 1 from training_prompt_dismissal where user_id=$1) as due`,
			[userId],
		)
	).rows[0];
	return row?.due ?? false;
}

/** Closing the card without continuing: nothing about consent is recorded. */
export async function dismissTrainingPrompt(userId: string) {
	await database().query(
		"insert into training_prompt_dismissal(user_id) values($1) on conflict(user_id) do nothing",
		[userId],
	);
}

/** Null when the project is not the user's. */
export async function projectTrainingExcluded(
	userId: string,
	projectId: string,
) {
	const row = (
		await database().query<{ training_excluded: boolean }>(
			"select training_excluded from project where id=$1 and user_id=$2",
			[projectId, userId],
		)
	).rows[0];
	return row ? row.training_excluded : null;
}

/** Excluding a project also withdraws the eligibility of its chats' earlier turns. */
export async function setProjectTrainingExcluded(
	userId: string,
	projectId: string,
	excluded: boolean,
) {
	const client = await database().connect();
	try {
		await client.query("begin");
		const updated = await client.query(
			"update project set training_excluded=$3 where id=$1 and user_id=$2 returning id",
			[projectId, userId, excluded],
		);
		if (!updated.rows.length)
			throw new Response("Project is not available.", { status: 404 });
		if (excluded)
			await client.query(
				`update api_turn t set training_eligible=false from agent_session s
				 where s.id=t.session_id and s.project_id=$1 and t.user_id=$2 and t.training_eligible`,
				[projectId, userId],
			);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
