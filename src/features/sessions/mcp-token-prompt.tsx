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

/** A row's inline field for the user's own token or API key, sealed on our server. */
export function McpTokenPrompt({
	ask,
	onSaved,
	onCancel,
}: {
	ask: TokenAsk;
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
	return (
		<li className="integration-row integration-token">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					mutation.mutate();
				}}
			>
				<label className="integration-field">
					<span>{tokenAskLine(ask.reason)}</span>
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						required
						value={token}
						placeholder="Token or API key"
						title="Sent as a bearer token. Use Header-Name: value for another header."
						onChange={(event) => setToken(event.target.value)}
					/>
				</label>
				{mutation.error ? (
					<p role="alert">{saveErrorMessage(mutation.error)}</p>
				) : null}
				<div className="integration-actions">
					<button
						type="button"
						className="integration-button-quiet"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="integration-button-primary"
						disabled={mutation.isPending || !token.trim()}
					>
						{mutation.isPending ? "Checking…" : "Save"}
					</button>
				</div>
			</form>
		</li>
	);
}
