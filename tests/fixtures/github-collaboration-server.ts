/** Component-only doubles: no authentication bypass, server import or agent execution. */
export function useServerFn<T>(fn: T): T {
	return fn;
}
export async function startPullRequestReviewChat() {
	throw new Error("Agent runs are disabled in this component fixture.");
}
export async function readWorkspacePreviewFn() {
	throw new Error("Workspace access is disabled in this component fixture.");
}
export async function startIssueChatFn() {
	throw new Error("Agent runs are disabled in this component fixture.");
}
