import { ArrowUpRight } from "lucide-react";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import { harnessAccess } from "#/domain/harness-access";
import { AgentProviderMark } from "./agent-provider-mark";

export function HarnessLogin({
	harnessId,
	connection,
	busy,
	onConnect,
}: {
	harnessId: AgentProviderId;
	connection: AgentConnection;
	busy: boolean;
	onConnect: () => void;
}) {
	const provider = agentProviderById(harnessId);
	const access = harnessAccess(provider, connection, null);
	if (harnessId === "claude") return null;
	if (
		access.readiness !== "authorizing" &&
		access.readiness !== "failed" &&
		access.readiness !== "expired"
	) {
		return null;
	}
	const title = {
		authorizing: `Sign in to ${provider.name}`,
		failed: `${provider.name} sign-in failed`,
		expired: `${provider.name} sign-in expired`,
	}[access.readiness];
	// Every expiry cause needs the same action; never imply that work was lost.
	const detail =
		access.readiness === "expired"
			? "Your plan changed or the login was revoked. Your chats and work are kept."
			: access.summary;

	return (
		<section className="harness-login" aria-label={title}>
			<span className="harness-login-mark" aria-hidden="true">
				<AgentProviderMark provider={harnessId} size={15} />
			</span>
			<div className="harness-login-text">
				<strong>{title}</strong>
				<small>{detail}</small>
				{access.userCode ? (
					<code className="harness-login-code">{access.userCode}</code>
				) : null}
			</div>
			{access.verificationUrl ? (
				<a
					className="harness-login-action harness-login-link"
					href={access.verificationUrl}
					target="_blank"
					rel="noreferrer"
				>
					{access.subscriptionActionLabel ?? "Open"}
					<ArrowUpRight size={13} aria-hidden="true" />
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
		</section>
	);
}
