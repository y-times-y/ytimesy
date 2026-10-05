import { Effect } from "effect";
import { withDatabaseScope } from "../adapters/database-scope";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { executeWorkflowRequest } from "../jobs/model-workflow-executor";

export default {
	async fetch(
		request: Request,
		env: { DATABASE_URL: string; MODEL_WORKFLOW_SECRET: string },
	) {
		try {
			return await withDatabaseScope(env.DATABASE_URL, () =>
				executeWorkflowRequest(request, env.MODEL_WORKFLOW_SECRET, () =>
					createFreestyleWorkspaceMachines(
						Effect.runSync(readFreestyleApiKey()),
					),
				),
			);
		} catch {
			// SQL/provider diagnostics may contain credentials; never expose them over HTTP.
			console.warn(
				"Edge model execution failed; inspect the durable turn record.",
			);
			return new Response(null, { status: 503 });
		}
	},
};
