import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState } from "react";
import {
	type ClaudeSubscriptionView,
	disconnectClaudeSubscriptionFn,
	getClaudeSubscription,
	saveClaudeSubscriptionFn,
} from "./claude-subscription.fn";
import { ModelProviderLogo } from "./model-provider-logo";

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

/** Settings > Agents: connect a Claude subscription with a setup token. */
export function ClaudeSubscriptionSettings() {
	const [token, setToken] = useState("");
	const [confirming, setConfirming] = useState(false);
	const { view, saving, removing } = useClaudeSubscription({
		onSaved: () => setToken(""),
	});
	const data = view.data;
	if (!data?.enabled) return null;
	const meta = claudeSubscriptionMeta(data);
	const connected = claudeSubscriptionUsable(data);
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (token.trim()) saving.mutate(token.trim());
	};
	return (
		<section className="settings-section" aria-label="Claude subscription">
			<ul className="settings-group">
				<li className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-icon">
							<ModelProviderLogo provider="anthropic" size={18} />
						</span>
						<div className="settings-row-text">
							<span className="settings-row-title">Claude subscription</span>
							<span className="settings-row-meta" title={meta.tooltip}>
								{meta.text}
							</span>
						</div>
					</div>
					<div className="settings-row-actions">
						{connected ? (
							confirming ? (
								<>
									<button
										type="button"
										className="settings-secondary"
										disabled={removing.isPending}
										onClick={() => setConfirming(false)}
									>
										Cancel
									</button>
									<button
										type="button"
										className="settings-danger"
										disabled={removing.isPending}
										onClick={() =>
											removing.mutate(undefined, {
												onSuccess: () => setConfirming(false),
											})
										}
									>
										{removing.isPending ? "Disconnecting…" : "Disconnect"}
									</button>
								</>
							) : (
								<>
									<span
										className="settings-badge"
										data-tone={data.status === "connected" ? "ok" : undefined}
									>
										{data.status === "connected" ? "Connected" : "Limited"}
									</span>
									<button
										type="button"
										className="settings-secondary"
										onClick={() => setConfirming(true)}
									>
										Disconnect
									</button>
								</>
							)
						) : null}
					</div>
				</li>
			</ul>
			{connected ? null : (
				<form className="settings-group settings-form-grid" onSubmit={onSubmit}>
					<label className="settings-field settings-field-wide">
						<span title="Run claude setup-token on your computer, then paste the token it prints.">
							Run <code>claude setup-token</code>, paste the token
						</span>
						<input
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder="sk-ant-oat01-…"
							value={token}
							onChange={(event) => setToken(event.target.value)}
						/>
					</label>
					<div className="settings-form-actions">
						<button
							type="submit"
							className="settings-primary"
							disabled={saving.isPending || !token.trim()}
						>
							{saving.isPending ? "Saving…" : "Connect"}
						</button>
					</div>
				</form>
			)}
			{saving.error ? <p role="alert">{saving.error.message}</p> : null}
			{removing.error ? <p role="alert">{removing.error.message}</p> : null}
		</section>
	);
}
