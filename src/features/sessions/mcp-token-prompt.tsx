import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { saveErrorMessage } from "#/lib/optimistic-mutation";
import type { PublicMcpServer } from "#/server/adapters/mcp-servers";
import type { McpSignInStart } from "#/server/services/mcp-oauth-client";
import { setMcpServerTokenFn } from "./mcp-servers.fn";

/** Why a server asks for a token: one short line. */
export type TokenAsk = { id: string; reason: "setup" | "token" };

export const tokenAskLine = (reason: TokenAsk["reason"]) =>
	reason === "setup"
		? "Sign-in for this service isn't set up yet. Paste a token instead."
		: "This service needs a token.";

export const SIGN_IN_FAILED = "Couldn't start sign-in. Try again.";

/** What a sign-in start asks the panel to do next. */
export function signInOutcome(
	id: string,
	result: McpSignInStart,
): { go: string } | { ask: TokenAsk } | { failed: true } | { done: true } {
	if (result.url) return { go: result.url };
	if ("needs" in result) return { ask: { id, reason: result.reason } };
	if ("failed" in result) return { failed: true };
	return { done: true };
}

/** Where each service hands out a token, for the one-line help link. */
const TOKEN_HELP: readonly { host: RegExp; href: string }[] = [
	{ host: /(^|\.)slack\.com$/, href: "https://api.slack.com/apps" },
	{
		host: /(^|\.)github(copilot)?\.com$/,
		href: "https://github.com/settings/tokens",
	},
	{
		host: /(^|\.)render\.com$/,
		href: "https://dashboard.render.com/u/settings#api-keys",
	},
	{
		host: /(^|\.)pagerduty\.com$/,
		href: "https://support.pagerduty.com/main/docs/api-access-keys",
	},
];

export function tokenHelpLink(url: string | undefined) {
	if (!url) return null;
	try {
		const host = new URL(url).host;
		return TOKEN_HELP.find((entry) => entry.host.test(host))?.href ?? null;
	} catch {
		return null;
	}
}

/** A row's inline field for the user's own token or API key, sealed on our server. */
export function McpTokenPrompt({
	ask,
	url,
	onSaved,
	onCancel,
}: {
	ask: TokenAsk;
	/** The server's address, for the "Get a token" link. */
	url?: string;
	onSaved: (servers: PublicMcpServer[]) => void;
	onCancel: () => void;
}) {
	const save = useServerFn(setMcpServerTokenFn);
	const [token, setToken] = useState("");
	const mutation = useMutation({
		mutationFn: () => save({ data: { id: ask.id, token } }),
		onSuccess: (servers) => {
			setToken("");
			onSaved(servers);
		},
	});
	const help = tokenHelpLink(url);
	return (
		<li className="integration-row integration-token">
			<form
				className="integration-token-form"
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate();
				}}
			>
				<div className="integration-token-line">
					<span>{tokenAskLine(ask.reason)}</span>
					{help ? (
						<a href={help} target="_blank" rel="noreferrer">
							Get a token
						</a>
					) : null}
				</div>
				<div className="integration-token-input">
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						required
						autoFocus
						aria-label="Token or API key"
						value={token}
						placeholder="Paste a token or API key"
						title="Sent as a bearer token. Use Header-Name: value for another header."
						onChange={(event) => setToken(event.target.value)}
					/>
					<button
						type="button"
						className="integration-token-cancel"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="integration-token-save"
						disabled={mutation.isPending || !token.trim()}
					>
						{mutation.isPending ? "Checking…" : "Save"}
					</button>
				</div>
				{mutation.error ? (
					<p className="integration-token-error" role="alert">
						{saveErrorMessage(mutation.error)}
					</p>
				) : null}
			</form>
		</li>
	);
}
