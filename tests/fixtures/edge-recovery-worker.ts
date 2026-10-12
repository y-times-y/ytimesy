/// <reference path="../../.ytimesy/edge-executor-runtime.d.ts" />
import { z } from "zod";
import { verifyDeliveryRequest } from "../../src/domain/delivery-auth";
import { modelConversationName } from "../../src/domain/model-conversation-routing";
import { database } from "../../src/server/adapters/database";
import { withDatabaseScope } from "../../src/server/adapters/database-scope";
import type { EdgeExecutorEnvironment } from "../../src/server/edge/environment";
import executor, {
	ModelConversation as ProductionConversation,
} from "../../src/server/edge/executor";

export {
	BackgroundJobRunner,
	ProjectEnvironmentWorkflow,
} from "../../src/server/edge/executor";

const proofScope = z
	.object({
		userId: z.string().min(1).max(256),
		sessionId: z.uuid(),
		turnId: z.uuid(),
		leaseId: z.uuid(),
	})
	.strict();

/** Operator-only build: only the disposable read-only fixture may be reset. */
export class ModelConversation extends ProductionConversation {
	private readonly incarnation = crypto.randomUUID();
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (!path.startsWith("/proof/")) return super.fetch(request);
		const secret = process.env.MODEL_WORKFLOW_SECRET;
		const body = await request.text();
		if (!secret || !(await verifyDeliveryRequest(secret, request, body)))
			return new Response(null, { status: 401 });
		const scope = proofScope.parse(JSON.parse(body));
		const identity = this.ctx.storage.sql
			.exec<{ name: string }>("select name from conversation_identity")
			.toArray()[0];
		if (identity?.name !== modelConversationName(scope))
			return new Response(null, { status: 403 });
		const receipts = this.ctx.storage.sql
			.exec<{
				index: number;
				state: string;
				startedAt: number;
			}>(
				"select step_index as 'index',state,started_at as startedAt from model_step where turn_id=? and lease_id=? order by step_index",
				scope.turnId,
				scope.leaseId,
			)
			.toArray();
		if (path === "/proof/status")
			return Response.json({ incarnation: this.incarnation, receipts });
		if (
			path !== "/proof/reset" ||
			!receipts.some((row) => row.state === "processing")
		)
			return new Response(null, { status: 409 });
		// Cloudflare documents that a thrown concurrency callback terminates and resets the object.
		await this.ctx.blockConcurrencyWhile(async () => {
			throw new Error("Operator-requested isolated recovery drill.");
		});
		return new Response(null, { status: 500 });
	}
}

export default {
	...executor,
	async fetch(request: Request, env: EdgeExecutorEnvironment) {
		const path = new URL(request.url).pathname;
		if (!path.startsWith("/proof/")) return executor.fetch(request, env);
		if (
			request.method !== "POST" ||
			Number(request.headers.get("content-length") ?? 0) > 1024
		)
			return new Response(null, { status: 404 });
		const body = await request.text();
		const secret = process.env.MODEL_WORKFLOW_SECRET;
		if (
			body.length > 1024 ||
			!secret ||
			!(await verifyDeliveryRequest(secret, request, body))
		)
			return new Response(null, { status: 401 });
		const parsed = proofScope.safeParse(JSON.parse(body));
		if (!parsed.success) return new Response(null, { status: 400 });
		const scope = parsed.data;
		const allowed = await withDatabaseScope(
			env.HYPERDRIVE.connectionString,
			async () => {
				const result = await database().query(
					`select 1 from api_turn t join agent_session s on s.id=t.session_id
				 join agent_session p on p.id=s.parent_session_id
				 where t.id=$1 and t.user_id=$2 and s.id=$3
				 and s.user_id=$2 and p.user_id=$2 and t.executor='durable-object'
				 and s.title='Read isolated proof marker' and p.title='Disposable edge proof'
				 and s.task_access='read_only'`,
					// Not the lease: a resumed turn runs under a rotated one; receipts keep the original.
					[scope.turnId, scope.userId, scope.sessionId],
				);
				return result.rowCount === 1;
			},
			null,
		);
		if (!allowed) return new Response(null, { status: 403 });
		return env.MODEL_CONVERSATIONS.getByName(
			modelConversationName(scope),
		).fetch(
			new Request(request.url, {
				method: "POST",
				body,
				headers: request.headers,
			}),
		);
	},
};
