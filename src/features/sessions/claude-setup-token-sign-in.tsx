import { Check } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	claudeSubscriptionUsable,
	useClaudeSubscription,
} from "./claude-subscription-settings";

const SETUP_TOKEN_HINT =
	"Run claude setup-token on your computer, then paste the token it prints.";

/**
 * Connects the Claude plan in place, as Settings > Agents does: the button
 * opens a field for the token `claude setup-token` prints, and saving it
 * asks Anthropic once.
 */
export function ClaudeSetupTokenSignIn({
	onConnected,
}: {
	onConnected?: () => void;
}) {
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState("");
	const { view, saving } = useClaudeSubscription({
		onSaved: (data) => {
			setToken("");
			if (claudeSubscriptionUsable(data)) onConnected?.();
		},
	});
	if (claudeSubscriptionUsable(view.data))
		return (
			<span className="chatgpt-sign-in-done">
				<Check size={14} strokeWidth={2.6} />
				Connected
			</span>
		);
	const refused = view.data?.enabled && view.data.status === "refused";
	const onSubmit = (event: FormEvent) => {
		event.preventDefault();
		if (token.trim()) saving.mutate(token.trim());
	};
	return (
		<div className="chatgpt-sign-in">
			{open ? (
				<form className="claude-token-form" onSubmit={onSubmit}>
					<input
						// Opened by a click on "Paste setup token", never on load.
						// biome-ignore lint/a11y/noAutofocus: the field the click asked for.
						autoFocus
						type="password"
						autoComplete="off"
						spellCheck={false}
						aria-label="Claude setup token"
						placeholder="sk-ant-oat01-…"
						value={token}
						disabled={saving.isPending}
						onChange={(event) => setToken(event.target.value)}
					/>
					<button
						type="submit"
						className="chatgpt-sign-in-button"
						disabled={saving.isPending || !token.trim()}
					>
						{saving.isPending ? "Saving…" : "Connect"}
					</button>
				</form>
			) : (
				<button
					type="button"
					className="chatgpt-sign-in-button"
					title={SETUP_TOKEN_HINT}
					onClick={() => setOpen(true)}
				>
					Paste setup token
				</button>
			)}
			<p className="chatgpt-sign-in-hint" title={SETUP_TOKEN_HINT}>
				Run <code>claude setup-token</code> in a terminal
			</p>
			{saving.error ? (
				<small role="alert">{saving.error.message}</small>
			) : refused ? (
				<small role="alert">Token refused. Run it again.</small>
			) : null}
		</div>
	);
}
