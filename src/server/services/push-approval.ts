import { pushApprovalOutcome } from "#/domain/push-approval";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { agentSessionForOwner } from "../adapters/agent-sessions";
import { gitPushRequests } from "../adapters/git-push-requests";

export const PUSH_APPROVAL_UNAVAILABLE =
	"This push can no longer be approved. Ask the agent to push again.";

/**
 * The card's Push: only the chat's owner, only a push card in that chat
 * still waiting for an answer, and only while its refused push is recent
 * and unanswered. The approval covers that push's exact commit, once.
 */
export async function approveChatPushRequest(
	input: { userId: string; sessionId: string; itemId: string },
	deps = { session: agentSessionForOwner, approve: gitPushRequests.approve },
) {
	const session = await deps.session(input.userId, input.sessionId);
	if (!session) throw new Error(PUSH_APPROVAL_UNAVAILABLE);
	const items = sessionItemsFromUnknown(session.items);
	const item = items.find((entry) => entry.id === input.itemId);
	if (
		item?.kind !== "pushApproval" ||
		pushApprovalOutcome(items, item.id) !== "pending"
	)
		throw new Error(PUSH_APPROVAL_UNAVAILABLE);
	if (!(await deps.approve(input.userId, item.requestId)))
		throw new Error(PUSH_APPROVAL_UNAVAILABLE);
}
