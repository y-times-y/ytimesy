import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { useState } from "react";
import { secretsAnsweredText } from "#/domain/secret-request";
import type { ChatWaitingOn } from "#/domain/sidebar-chats";
import { answerThreadFn, readThreadAskFn } from "../sessions/agent-session.fn";
import { SecretRequestCard } from "../sessions/secret-request-card";
import { UserQuestionCard } from "../sessions/user-question-card";
import { saveProjectSecretFn } from "./project-secrets.fn";

/** What Retry sends: the thread continues where its failed turn stopped. */
export const INBOX_RETRY_TEXT =
	"Your last turn failed. Retry it: continue where you stopped and finish the work.";

/** Which waits the inbox can answer without opening the thread. */
export const inboxAnswerable = (waitingOn: ChatWaitingOn) =>
	waitingOn === "question" || waitingOn === "secret" || waitingOn === "failed";

/**
 * Inline controls under a Needs-you row of the Super agent's overview: answer
 * a thread's question with its own buttons, paste a requested secret (saved
 * straight to project settings, never through any model), or retry a failed
 * thread. The answer is the person's own message to the thread.
 */
export function YInboxControls({
	projectId,
	threadId,
	title,
	waitingOn,
	onOpen,
}: {
	projectId: string;
	threadId: string;
	title: string;
	waitingOn: ChatWaitingOn;
	onOpen: (threadId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const client = useQueryClient();
	const answer = useMutation({
		mutationFn: async (text: string) => {
			const result = await answerThreadFn({
				data: { projectId, threadId, text, answerId: crypto.randomUUID() },
			});
			if (!result.ok) throw new Error(result.error);
			return result;
		},
		onSuccess: () =>
			client.invalidateQueries({ queryKey: ["agent-sessions", projectId] }),
	});
	const ask = useQuery({
		queryKey: ["thread-ask", threadId],
		queryFn: () => readThreadAskFn({ data: { projectId, threadId } }),
		enabled: open && waitingOn !== "failed" && !answer.isSuccess,
		staleTime: 0,
	});
	if (!inboxAnswerable(waitingOn)) return null;
	if (answer.isSuccess)
		return (
			<p className="y-inbox-done">
				<Check size={14} aria-hidden="true" /> Sent to {title}
			</p>
		);
	if (waitingOn === "failed")
		return (
			<div className="y-inbox-actions">
				<button
					type="button"
					className="y-inbox-button"
					data-primary="true"
					disabled={answer.isPending}
					onClick={() => answer.mutate(INBOX_RETRY_TEXT)}
				>
					{answer.isPending ? "Retrying…" : "Retry"}
				</button>
				<button
					type="button"
					className="y-inbox-button"
					onClick={() => onOpen(threadId)}
				>
					Open thread
				</button>
				{answer.error ? (
					<span className="y-inbox-error">{answer.error.message}</span>
				) : null}
			</div>
		);
	return (
		<div className="y-inbox">
			{open ? null : (
				<button
					type="button"
					className="y-inbox-button"
					data-primary="true"
					onClick={() => setOpen(true)}
				>
					{waitingOn === "secret" ? "Enter it here" : "Answer here"}
				</button>
			)}
			{open && ask.isPending ? (
				<p className="y-inbox-note">Reading the question…</p>
			) : null}
			{open && !ask.isPending && !ask.data ? (
				<p className="y-inbox-note">
					This needs the thread itself.{" "}
					<button
						type="button"
						className="y-inbox-link"
						onClick={() => onOpen(threadId)}
					>
						Open thread
					</button>
				</p>
			) : null}
			{open && ask.data?.kind === "question" ? (
				<UserQuestionCard
					item={ask.data.item}
					reply={null}
					actions={{
						disabled: answer.isPending,
						onAnswer: (text) => answer.mutate(text),
					}}
				/>
			) : null}
			{open && ask.data?.kind === "secret" ? (
				<SecretRequestCard
					item={ask.data.item}
					outcome="pending"
					actions={{
						disabled: answer.isPending,
						onSave: async ({ name, value, kind }) => {
							await saveProjectSecretFn({
								data: { projectId, name, value, kind },
							});
						},
						onAnswer: (saved, skipped) =>
							answer.mutate(secretsAnsweredText(saved, skipped)),
					}}
				/>
			) : null}
			{answer.error ? (
				<p className="y-inbox-error">{answer.error.message}</p>
			) : null}
		</div>
	);
}
