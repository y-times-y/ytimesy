import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
	type ClaudeSubscriptionView,
	disconnectClaudeSubscriptionFn,
	getClaudeSubscription,
	saveClaudeSubscriptionFn,
} from "./claude-subscription.fn";

export const CLAUDE_SUBSCRIPTION_KEY = ["claude-subscription"];

/** One line for the row; the details live in its tooltip. */
export function claudeSubscriptionMeta(
	view: Extract<ClaudeSubscriptionView, { enabled: true }>,
	now = Date.now(),
): { text: string; tooltip: string } {
	switch (view.status) {
		case "connected":
			return {
				text: "Runs on your Claude plan",
				tooltip:
					"Chats on these models run the Claude Agent SDK on the chat's machine. Your token stays on our servers.",
			};
		case "limited": {
			const minutes = view.limitedUntil
				? Math.max(1, Math.ceil((view.limitedUntil - now) / 60_000))
				: null;
			return {
				text: minutes
					? `Usage used up · resets in ${minutes >= 60 ? `${Math.floor(minutes / 60)} h` : `${minutes} min`}`
					: "Usage used up for now",
				tooltip: "Turns move to your other models until your plan resets.",
			};
		}
		case "refused":
			return {
				text: "Token refused",
				tooltip:
					"Anthropic refused the saved token. Run claude setup-token again and paste the new one.",
			};
		default:
			return {
				text: "Use your Claude Pro or Max plan",
				tooltip:
					"Run claude setup-token on your computer, then paste the token it prints.",
			};
	}
}

/**
 * The account's Claude subscription: its state, and saving or removing the
 * setup token. Settings > Agents and the first run's Claude card share it,
 * so either one updates the model picker the same way.
 */
export function useClaudeSubscription({
	onSaved,
}: {
	/** After a token is saved (accepted or refused). */
	onSaved?: (view: ClaudeSubscriptionView) => void;
} = {}) {
	const queryClient = useQueryClient();
	const read = useServerFn(getClaudeSubscription);
	const save = useServerFn(saveClaudeSubscriptionFn);
	const disconnect = useServerFn(disconnectClaudeSubscriptionFn);
	const view = useQuery({
		queryKey: CLAUDE_SUBSCRIPTION_KEY,
		queryFn: () => read(),
		staleTime: 30_000,
	});
	const refresh = (data: ClaudeSubscriptionView) => {
		queryClient.setQueryData(CLAUDE_SUBSCRIPTION_KEY, data);
		void queryClient.invalidateQueries({ queryKey: ["agent-model-catalog"] });
		void queryClient.invalidateQueries({
			queryKey: ["model-failover-settings"],
		});
	};
	const saving = useMutation({
		mutationFn: (token: string) => save({ data: { token } }),
		onSuccess: (data) => {
			refresh(data);
			onSaved?.(data);
		},
	});
	const removing = useMutation({
		mutationFn: () => disconnect({ data: {} }),
		onSuccess: refresh,
	});
	return { view, saving, removing };
}

/** Connected or limited: the token works, the plan may only be spent for now. */
export function claudeSubscriptionUsable(
	view: ClaudeSubscriptionView | undefined,
) {
	return (
		view?.enabled === true &&
		(view.status === "connected" || view.status === "limited")
	);
}
