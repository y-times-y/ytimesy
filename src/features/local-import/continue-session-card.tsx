import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import {
	LOCAL_AGENT_NAMES,
	LOCAL_AGENTS,
	localImportSettled,
	localImportStatusLine,
} from "#/domain/local-import-view";
import { requestJson } from "../projects/api";
import { LocalAgentMark } from "./local-agent-mark";
import { createLocalImportFn, localImportStatusFn } from "./local-import.fn";
import "./continue-session-card.css";

const POLL_MS = 2000;

/**
 * "Continue your agent session" in a new chat's empty state: Copy prompt puts
 * a one-time code and instructions on the clipboard for the user's local
 * coding agent, and the status line follows the import until its chat is
 * ready. Everything here renders from server props first: the import only
 * exists after a click, so the first paint never depends on client state.
 */
export function ContinueSessionCard({
	githubConnected,
}: {
	githubConnected: boolean;
}) {
	const createImport = useServerFn(createLocalImportFn);
	const readStatus = useServerFn(localImportStatusFn);
	const [importId, setImportId] = useState<string | null>(null);
	const [copyFailed, setCopyFailed] = useState(false);
	const copy = useMutation({
		mutationFn: async () => {
			const created = await createImport({ data: {} });
			setImportId(created.importId);
			try {
				await navigator.clipboard.writeText(created.prompt);
				setCopyFailed(false);
			} catch {
				setCopyFailed(true);
			}
			return created;
		},
	});
	const status = useQuery({
		queryKey: ["local-import", importId],
		queryFn: () => readStatus({ data: { importId: importId as string } }),
		enabled: importId !== null,
		refetchInterval: (query) =>
			query.state.data && localImportSettled(query.state.data.status)
				? false
				: POLL_MS,
		refetchIntervalInBackground: true,
	});
	const connect = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => window.location.assign(url),
	});
	const view = status.data;
	const ready = view?.status === "ready" && view.projectId && view.sessionId;
	const line = copy.isError
		? copy.error instanceof Error
			? copy.error.message
			: "Could not make a code. Try again."
		: copyFailed
			? "Copy was blocked. Allow clipboard access and try again."
			: view
				? localImportStatusLine(view)
				: copy.isSuccess || importId
					? "Waiting for your agent…"
					: "Paste it into your local coding agent.";
	return (
		<section
			className="continue-card"
			aria-labelledby="continue-card-title"
			data-state={view?.status ?? (importId ? "waiting" : "idle")}
		>
			<div className="continue-card-head">
				<span id="continue-card-title" className="continue-card-title">
					Continue your agent session
				</span>
				<ul className="continue-card-agents" aria-label="Supported agents">
					{LOCAL_AGENTS.map((agent) => (
						<li key={agent} title={LOCAL_AGENT_NAMES[agent]}>
							<LocalAgentMark agent={agent} size={14} />
							<span className="sr-only">{LOCAL_AGENT_NAMES[agent]}</span>
						</li>
					))}
				</ul>
			</div>
			{githubConnected ? (
				<div className="continue-card-row">
					<button
						type="button"
						className="continue-card-copy"
						onClick={() => copy.mutate()}
						disabled={copy.isPending}
						title="The prompt has a one-time code (15 minutes). Your agent runs one command, asks what to import, then pushes your work to a ytimesy branch."
					>
						{copy.isSuccess && !copyFailed ? (
							<Check size={14} aria-hidden="true" />
						) : (
							<Copy size={14} aria-hidden="true" />
						)}
						{importId ? "Copy new prompt" : "Copy prompt"}
					</button>
					<span
						className="continue-card-status"
						role="status"
						title={
							view?.status === "ready" && view.message
								? view.message
								: "Your agent reads your local sessions, uploads them, and pushes your code. .env values go to Settings > Project for review."
						}
					>
						{line}
					</span>
					{ready ? (
						<a
							className="continue-card-open"
							href={`/?project=${view.projectId}&chat=${view.sessionId}`}
						>
							Open chat
						</a>
					) : null}
				</div>
			) : (
				<div className="continue-card-row">
					<button
						type="button"
						className="continue-card-copy"
						onClick={() => connect.mutate()}
						disabled={connect.isPending}
					>
						Connect GitHub first
					</button>
					<span className="continue-card-status">
						{connect.isError
							? "Could not start GitHub sign-in. Try again."
							: "Imports push your code to GitHub."}
					</span>
				</div>
			)}
		</section>
	);
}
