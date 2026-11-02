import { ArrowUpRight } from "lucide-react";
import type { AgentConnection } from "#/domain/agent-connection";
import {
	type AgentProviderId,
	agentProviderById,
} from "#/domain/agent-provider";
import {
	connectionFailureIsSignIn,
	harnessAccess,
	harnessLoginShouldShow,
} from "#/domain/harness-access";
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
	const access = harnessAccess(provider, connection);
	if (
		access.readiness !== "authorizing" &&
		access.readiness !== "failed" &&
		access.readiness !== "expired"
	) {
		return null;
	}
	const title = {
		authorizing: `Sign in to ${provider.name}`,
		failed: connectionFailureIsSignIn(access.summary)
			? `${provider.name} sign-in failed`
			: "Couldn't start the chat",
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
				<AgentProviderMark provider={harnessId} size={16} />
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
					<ArrowUpRight size={14} aria-hidden="true" />
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

/**
 * The sign-in card above the composer, outside the model picker: a send with
 * an expired or pending login starts sign-in and keeps the message, so the
 * card (with the device code) must be visible without opening a menu.
 */
export function ComposerSignIn(props: {
	harnessReady: boolean;
	harnessId: AgentProviderId;
	connection: AgentConnection;
	busy: boolean;
	onConnect: () => void;
}) {
	if (
		!harnessLoginShouldShow({
			harnessReady: props.harnessReady,
			harnessId: props.harnessId,
			connection: props.connection,
		})
	)
		return null;
	return (
		<HarnessLogin
			harnessId={props.harnessId}
			connection={props.connection}
			busy={props.busy}
			onConnect={props.onConnect}
		/>
	);
}
