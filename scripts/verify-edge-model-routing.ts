import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { closeDatabase, database } from "../src/server/adapters/database";
import { modelWorkflowSigningSecret } from "../src/server/adapters/model-workflow-dispatch";

const projectRef = "exampledevprojectref";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !==
		projectRef ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(projectRef)
)
	throw new Error("Not the approved development database.");
const endpoint =
	"https://ytimesy-edge-executor-development.example-account.workers.dev/model-step";
const turnIds = [randomUUID(), randomUUID()];
const leaseId = randomUUID();
/** Terminal synthetic turns exercise the deployed DO routing without inference or repository tools. */
try {
	for (const [index, id] of turnIds.entries()) {
		const inserted = await database().query(
			`insert into api_turn(id,session_id,user_id,connection_id,connection_revision,model_id,state,lease_id,executor)
		 select $1,s.id,s.user_id,null,'routing-proof','routing-proof','completed',$2,$3
		 from agent_session s order by s.created_at desc limit 1 returning id`,
			[id, leaseId, index === 0 ? "durable-object" : "node"],
		);
		if (!inserted.rowCount)
			throw new Error(
				"No development chat is available for the routing proof.",
			);
	}
	const secret = modelWorkflowSigningSecret();
	for (const [index, id] of turnIds.entries()) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const body = JSON.stringify({ turnId: id, leaseId, index: 1 });
			const send = async () =>
				fetch(endpoint, {
					method: "POST",
					body,
					headers: await signDeliveryRequest(secret, "POST", endpoint, body),
					signal: AbortSignal.timeout(30_000),
				});
			let response = await send();
			for (
				let propagation = 0;
				response.status === 503 && propagation < 30;
				propagation++
			) {
				await delay(2000);
				response = await send();
			}
			if (index === 0) {
				if (
					!response.ok ||
					((await response.json()) as { outcome: string }).outcome !==
						"completed"
				)
					throw new Error(`DO terminal routing failed (${response.status}).`);
			} else if (response.status !== 409) {
				throw new Error(
					`Node ownership rejection failed (${response.status}).`,
				);
			}
		}
	}
	const startUrl = new URL("/start", endpoint).href;
	const admission = JSON.stringify({ turnId: turnIds[0], leaseId });
	// The chat admits the turn; repeating the admission is idempotent.
	for (let attempt = 0; attempt < 2; attempt++) {
		const response = await fetch(startUrl, {
			method: "POST",
			body: admission,
			headers: await signDeliveryRequest(secret, "POST", startUrl, admission),
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status !== 202)
			throw new Error(`Chat turn admission failed (${response.status}).`);
	}
	console.log(
		"Live development DO terminal routing/reconnect, Node ownership rejection, and chat turn admission passed. No inference or VMs used.",
	);
} finally {
	try {
		await database().query(
			"delete from api_turn where id=any($1::uuid[]) and model_id='routing-proof'",
			[turnIds],
		);
	} finally {
		await closeDatabase();
	}
}
