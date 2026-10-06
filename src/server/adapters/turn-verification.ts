import { z } from "zod";
import {
	type CompletedVerification,
	completedVerification,
} from "#/domain/completion-verification";
import { database } from "./database";

const baselineSchema = z.object({
	type: z.literal("verification-baseline"),
	directory: z.string(),
	base: z.string().regex(/^[a-f0-9]{40,64}$/),
});

export async function readVerificationBaseline(
	userId: string,
	sessionId: string,
	directory: string,
) {
	const result = await database().query<{ response: { result: unknown } }>(
		`select r.response from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.id=$1 and s.user_id=$2 and r.request_id=$3 and r.status='done' and r.response->>'ok'='true'`,
		[sessionId, userId, `verification-baseline:${directory}`],
	);
	const baseline = baselineSchema.safeParse(result.rows[0]?.response.result);
	return baseline.success && baseline.data.directory === directory
		? baseline.data.base
		: null;
}

export async function pinVerificationBaseline(
	userId: string,
	sessionId: string,
	directory: string,
	base: string,
) {
	const baseline = baselineSchema.parse({
		type: "verification-baseline",
		directory,
		base,
	});
	const key = `verification-baseline:${directory}`;
	await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
		on conflict(parent_session_id,request_id) do nothing`,
		[
			sessionId,
			userId,
			key,
			JSON.stringify({ id: key, ok: true, result: baseline }),
		],
	);
	if ((await readVerificationBaseline(userId, sessionId, directory)) !== base)
		throw new Error(
			"The task's server-owned baseline is unavailable or changed.",
		);
}

/** Server-owned evidence uses the existing journal; guests cannot author acceptance receipts. */
export async function recordCompletedVerification(
	userId: string,
	sessionId: string,
	receipt: CompletedVerification,
) {
	const verified = completedVerification.parse(receipt);
	const key = `completion-verification:${verified.turn}:${verified.directory}`;
	const saved = await database().query(
		`insert into agent_task_command_receipt(parent_session_id,request_id,status,response,completed_at)
		 select id,$3,'done',$4::jsonb,now() from agent_session where id=$1 and user_id=$2
		 on conflict (parent_session_id,request_id) do update set response=excluded.response,status='done',completed_at=now(),updated_at=now()
		 returning request_id`,
		[
			sessionId,
			userId,
			key,
			JSON.stringify({ id: key, ok: true, result: verified }),
		],
	);
	if (!saved.rowCount)
		throw new Error("Verification task is no longer available.");
}

export async function findCompletedVerification(
	userId: string,
	sessionId: string,
	directory: string,
	identity: { base: string; tree?: string; patchSha256: string },
) {
	const result = await database().query<{ response: { result: unknown } }>(
		`select r.response from agent_task_command_receipt r join agent_session s on s.id=r.parent_session_id
		 where s.id=$1 and s.user_id=$2 and r.status='done' and r.response->>'ok'='true'
		 and r.response->'result'->>'type'='completion-verification'
		 and r.response->'result'->>'directory'=$3 and r.response->'result'->>'base'=$4
		 and ($5::text is null or r.response->'result'->>'tree'=$5) and r.response->'result'->>'patchSha256'=$6
		 order by r.completed_at desc limit 1`,
		[
			sessionId,
			userId,
			directory,
			identity.base,
			identity.tree ?? null,
			identity.patchSha256,
		],
	);
	const receipt = completedVerification.safeParse(
		result.rows[0]?.response.result,
	);
	return receipt.success ? receipt.data : null;
}
