import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { AgentConnection } from "#/domain/agent-connection";
import { agentSetupContent } from "./agent-setup-content";
import { CodexMark } from "./codex-mark";

export function AgentSetup({
	connection,
	snapshotAvailable,
	busy,
	onConnect,
}: {
	connection: AgentConnection;
	snapshotAvailable: boolean;
	busy: boolean;
	onConnect: () => void;
}) {
	const content = agentSetupContent(connection, snapshotAvailable);
	const [copied, setCopied] = useState(false);
	if (!content) return null;
	const userCode = content.userCode;

	async function copyCode() {
		if (!userCode) return;
		try {
			await navigator.clipboard.writeText(userCode);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	}

	return (
		<section
			className="agent-setup"
			data-status={connection.status}
			aria-label="Codex"
			role={connection.status === "failed" ? "alert" : "status"}
		>
			<span className="agent-setup-mark">
				<CodexMark size={24} />
			</span>
			<div className="agent-setup-copy">
				<h2>{content.title}</h2>
				<p>{content.detail}</p>
			</div>
			{content.verificationUrl ? (
				<a
					className="agent-setup-action"
					href={content.verificationUrl}
					target="_blank"
					rel="noreferrer"
				>
					{content.actionLabel}
				</a>
			) : content.actionLabel ? (
				<button
					type="button"
					className="agent-setup-action"
					onClick={onConnect}
					disabled={busy}
				>
					{busy ? "Signing in…" : content.actionLabel}
				</button>
			) : null}
			{content.userCode ? (
				<div className="agent-setup-code">
					<code>{content.userCode}</code>
					<button
						type="button"
						onClick={() => void copyCode()}
						aria-label={copied ? "Code copied" : "Copy code"}
					>
						{copied ? <Check size={16} /> : <Copy size={16} />}
						{copied ? "Copied" : "Copy"}
					</button>
				</div>
			) : null}
		</section>
	);
}
