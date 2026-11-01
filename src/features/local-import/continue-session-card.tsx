import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
	LOCAL_AGENT_NAMES,
	LOCAL_AGENTS,
	localImportSettled,
	localImportStatusLine,
} from "#/domain/local-import-view";
import { requestJson } from "../projects/api";
import { LocalAgentMark } from "./local-agent-mark";
import {
	cancelLocalImportFn,
	createLocalImportFn,
	localImportStatusFn,
} from "./local-import.fn";
import {
	clearPendingImport,
	markImportPending,
	useCardWatchesImport,
} from "./use-import-finish-alert";
import "./continue-session-card.css";

const POLL_MS = 2000;
/** How long the button reads "Copied" before "Copy again". */
const COPIED_MS = 1800;

/**
 * "Continue your agent session", in onboarding and in Settings > Import: Copy prompt puts
 * a one-time code and instructions on the clipboard for the user's local
 * coding agent, and the status line follows the import until its chat is
 * ready. Everything here renders from server props first: the import only
 * exists after a click, so the first paint never depends on client state.
 */
export function ContinueSessionCard({
	githubConnected,
	heading = true,
}: {
	githubConnected: boolean;
	/** Off where the page already names the step (onboarding). */
	heading?: boolean;
}) {
	const createImport = useServerFn(createLocalImportFn);
	const readStatus = useServerFn(localImportStatusFn);
	const cancelImport = useServerFn(cancelLocalImportFn);
	const queryClient = useQueryClient();
	const titleId = useId();
	const [importId, setImportId] = useState<string | null>(null);
	const [codeExpiresAt, setCodeExpiresAt] = useState<number | null>(null);
	const [copyFailed, setCopyFailed] = useState(false);
	const [justCopied, setJustCopied] = useState(false);
	const copy = useMutation({
		mutationFn: async () => {
			const created = await createImport({ data: {} });
			setImportId(created.importId);
			setCodeExpiresAt(Date.parse(created.expiresAt));
			try {
				await navigator.clipboard.writeText(created.prompt);
				setCopyFailed(false);
				setJustCopied(true);
			} catch {
				setCopyFailed(true);
			}
			// The workspace says so if it finishes after the user leaves this card.
			markImportPending(created.importId);
			return created;
		},
	});
	useEffect(() => {
		if (!justCopied) return;
		const timer = window.setTimeout(() => setJustCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [justCopied]);
	useCardWatchesImport(importId);
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
	const cancel = useMutation({
		mutationFn: (id: string) => cancelImport({ data: { importId: id } }),
		onSuccess: (next) => {
			queryClient.setQueryData(["local-import", next.id], next);
			clearPendingImport(next.id);
		},
	});
	// A code nobody used reads as expired even if a status read is missing.
	const view =
		status.data?.status === "waiting" &&
		codeExpiresAt !== null &&
		Date.now() >= codeExpiresAt
			? { ...status.data, status: "expired" as const }
			: status.data;
	const waiting =
		importId !== null && !(view && localImportSettled(view.status));
	const settledHere = Boolean(view && localImportSettled(view.status));
	// Seen here, so the workspace does not announce it again.
	useEffect(() => {
		if (settledHere && importId) clearPendingImport(importId);
	}, [settledHere, importId]);
	const ready = view?.status === "ready" && view.projectId && view.sessionId;
	const line = cancel.isError
		? "Could not cancel. Try again."
		: copy.isError
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
			aria-labelledby={titleId}
			data-state={view?.status ?? (importId ? "waiting" : "idle")}
		>
			<div className="continue-card-head">
				<span
					id={titleId}
					className={heading ? "continue-card-title" : "sr-only"}
				>
					Continue your agent session
				</span>
				<ul className="continue-card-agents" aria-label="Supported agents">
					{LOCAL_AGENTS.map((agent) => (
						<li key={agent} title={LOCAL_AGENT_NAMES[agent]}>
							<LocalAgentMark agent={agent} size={18} />
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
						{justCopied ? (
							<Check size={14} aria-hidden="true" />
						) : (
							<Copy size={14} aria-hidden="true" />
						)}
						{copyButtonLabel({ copied: importId !== null, justCopied })}
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
					{waiting ? (
						<button
							type="button"
							className="continue-card-cancel"
							disabled={cancel.isPending}
							onClick={() => importId && cancel.mutate(importId)}
							title="Stops this import. Your agent's command stops at its next step."
						>
							Cancel
						</button>
					) : null}
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

/** "Copy prompt", then "Copied" for a moment, then "Copy again" (a new code). */
export function copyButtonLabel(input: {
	readonly copied: boolean;
	readonly justCopied: boolean;
}) {
	if (input.justCopied) return "Copied";
	return input.copied ? "Copy again" : "Copy prompt";
}
