import { Check, Copy } from "lucide-react";
import { useState } from "react";
import type { AgentConnection } from "#/domain/agent-connection";
import { AgentProviderMark } from "./agent-provider-mark";
import { agentSetupContent } from "./agent-setup-content";

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

	async function copyCode(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	}

	return (
		<section className="agent-setup" aria-label={content.heading}>
			<h2>{content.heading}</h2>
			{content.providers.map((row) => {
				const status =
					connection.status !== "disconnected" &&
					connection.provider === row.provider.id
						? connection.status
						: "disconnected";
				return (
					<div
						key={row.provider.id}
						className="agent-provider"
						data-provider={row.provider.id}
						data-status={status}
						role={status === "failed" ? "alert" : "status"}
					>
						<span className="agent-setup-mark">
							<AgentProviderMark provider={row.provider.id} size={24} />
						</span>
						<div className="agent-setup-copy">
							<h3>{row.provider.name}</h3>
							<p>{row.detail}</p>
						</div>
						{row.verificationUrl ? (
							<a
								className="agent-setup-action"
								href={row.verificationUrl}
								target="_blank"
								rel="noreferrer"
							>
								{row.actionLabel}
							</a>
						) : row.actionLabel ? (
							<button
								type="button"
								className="agent-setup-action"
								onClick={onConnect}
								disabled={busy}
							>
								{busy ? "Signing in…" : row.actionLabel}
							</button>
						) : null}
						{row.userCode ? (
							<div className="agent-setup-code">
								<code>{row.userCode}</code>
								<button
									type="button"
									onClick={() => void copyCode(row.userCode ?? "")}
									aria-label={copied ? "Code copied" : "Copy code"}
								>
									{copied ? <Check size={16} /> : <Copy size={16} />}
									{copied ? "Copied" : "Copy"}
								</button>
							</div>
						) : null}
					</div>
				);
			})}
		</section>
	);
}
