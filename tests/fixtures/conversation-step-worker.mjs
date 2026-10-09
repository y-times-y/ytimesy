import { DurableObject } from "cloudflare:workers";
import { claimConversationStep } from "../../src/domain/conversation-step-receipts.ts";
import { SqliteConversationSteps } from "../../src/server/edge/conversation-step-storage.ts";

// Local-only fixture: exercise the production SQLite adapter without database or inference access.
export class ReceiptFixture extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.receipts = new SqliteConversationSteps(ctx.storage.sql);
	}
	async fetch(request) {
		const { step, outcome } = await request.json();
		return Response.json(
			outcome
				? this.receipts.finish(step, outcome)
				: claimConversationStep(this.receipts, step),
		);
	}
}
export default {
	fetch(request, env) {
		return env.RECEIPTS.getByName(new URL(request.url).pathname).fetch(request);
	},
};
