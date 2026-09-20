import { useState } from "react";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { claudeAuthNeedsPaste, harnessAccess } from "#/domain/harness-access";

export function HarnessLogin({
	harnessId,
	connection,
	busy,
	onConnect,
	onSubmitAuthCode,
}: {
	harnessId: AgentProviderId;
	connection: AgentConnection;
	busy: boolean;
	onConnect: () => void;
	onSubmitAuthCode: (code: string) => void;
}) {
	const access = harnessAccess(agentProviderById(harnessId), connection, null);
	const [pasteCode, setPasteCode] = useState("");
	const needsPaste = claudeAuthNeedsPaste(connection);
	if (access.readiness === "ready") return null;
	if (
		access.readiness !== "authorizing" &&
		access.readiness !== "failed" &&
		access.readiness !== "expired"
	) {
		return null;
	}

	return (
		<div className="harness-login">
			<p className="harness-login-copy">{access.summary}</p>
			{access.userCode ? (
				<p className="harness-login-code">{access.userCode}</p>
			) : null}
			{needsPaste ? (
				<form
					className="harness-login-row"
					onSubmit={(event) => {
						event.preventDefault();
						const code = pasteCode.trim();
						if (!code || busy) return;
						onSubmitAuthCode(code);
					}}
				>
					<input
						className="harness-login-input"
						value={pasteCode}
						onChange={(event) => setPasteCode(event.currentTarget.value)}
						placeholder="Paste code from Anthropic"
						autoComplete="off"
						spellCheck={false}
						disabled={busy}
						aria-label="Anthropic login code"
					/>
					<button
						type="submit"
						className="harness-login-action"
						disabled={busy || !pasteCode.trim()}
					>
						Continue
					</button>
				</form>
			) : null}
			<div className="harness-login-row">
				{access.verificationUrl ? (
					<a
						className="harness-login-action"
						href={access.verificationUrl}
						target="_blank"
						rel="noreferrer"
					>
						{access.subscriptionActionLabel ?? "Open"}
					</a>
				) : access.subscriptionActionLabel ? (
					<button
						type="button"
						className="harness-login-action"
						disabled={busy}
						onClick={onConnect}
					>
						{access.subscriptionActionLabel}
					</button>
				) : null}
			</div>
		</div>
	);
}
