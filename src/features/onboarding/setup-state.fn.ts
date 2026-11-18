import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import type { FirstRunState } from "#/domain/first-run";
import { xaiSubscriptionEnabled } from "#/domain/xai-subscription";
import { claudeSubscriptionStatus } from "#/server/adapters/claude-subscription";
import { listModelConnections } from "#/server/adapters/model-connections";
import { loadAgentAccount } from "#/server/auth/agent-account";
import { requireUser } from "#/server/auth/auth";
import { githubConnectionExists } from "#/server/auth/github-connection";

/**
 * Where the signed-in account stands for the setup card: GitHub signed in,
 * and whether a model is ready to run chats. Read on demand, so the page
 * itself never waits on it.
 */
export const getSetupState = createServerFn({ method: "GET" }).handler(
	async (): Promise<FirstRunState> => {
		const user = await requireUser(getRequest().headers);
		const claudeSubscription = claudeSubscriptionEnabled();
		const [githubConnected, account, connections, claude] = await Promise.all([
			githubConnectionExists(user.id),
			loadAgentAccount(user.id),
			listModelConnections(user.id),
			claudeSubscription
				? claudeSubscriptionStatus(user.id).catch(() => null)
				: null,
		]);
		return {
			githubConnected,
			modelReady:
				account.status === "connected" ||
				connections.length > 0 ||
				claude?.status === "connected" ||
				claude?.status === "limited",
			...(xaiSubscriptionEnabled() ? { xaiSubscription: true } : {}),
			...(claudeSubscription ? { claudeSubscription: true } : {}),
		};
	},
);
