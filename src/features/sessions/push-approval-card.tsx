import { Check, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import {
	type PushCardState,
	pushAnswerLine,
	pushApprovalQuestion,
} from "#/domain/push-approval";
import type { PushApprovalItem } from "#/domain/session-item";

export type PushApprovalActions = {
	readonly disabled: boolean;
	/** The server's view of a card the transcript shows as pending (it settles expired and outdated ones). */
	readonly status: (itemId: string) => Promise<PushCardState>;
	/** Pushes the approved commit server-side; resolves to the card's new state. */
	readonly push: (itemId: string) => Promise<PushCardState>;
	readonly cancel: (itemId: string) => Promise<PushCardState>;
};

/**
 * The agent asked to push to the repository's default branch. Push pushes
 * that exact commit from the server; Cancel leaves it on its branch. Neither
 * starts a turn: the chat gets a notice. An expired or outdated card says so
 * and cannot be pushed.
 */
export function PushApprovalCard({
	item,
	outcome,
	actions,
}: {
	item: PushApprovalItem;
	/** The answer the transcript shows (its notice), else pending. */
	outcome: PushCardState;
	actions?: PushApprovalActions;
}) {
	const [state, setState] = useState<PushCardState>(outcome);
	const [working, setWorking] = useState<"push" | "cancel" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const status = actions?.status;
	// The transcript's answer (its notice) wins once it arrives.
	const shownAnswer = outcome.answer;
	const shownDetail = outcome.answer === "pending" ? "" : outcome.detail;
	useEffect(() => {
		if (shownAnswer !== "pending")
			setState({ answer: shownAnswer, detail: shownDetail });
	}, [shownAnswer, shownDetail]);
	// A pending card is checked once when shown: it may have expired or gone stale.
	useEffect(() => {
		if (shownAnswer !== "pending" || !status) return;
		let current = true;
		status(item.id).then(
			(next) => {
				if (current) setState(next);
			},
			() => {},
		);
		return () => {
			current = false;
		};
	}, [item.id, shownAnswer, status]);

	async function answer(kind: "push" | "cancel") {
		if (!actions || working) return;
		setWorking(kind);
		setError(null);
		try {
			setState(await actions[kind](item.id));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not answer the card.",
			);
		} finally {
			setWorking(null);
		}
	}

	const pending = state.answer === "pending" && actions;
	return (
		<section
			className="plan-proposal"
			data-outcome={
				state.answer === "pushed"
					? "approved"
					: state.answer === "pending"
						? "pending"
						: undefined
			}
			aria-label="Push approval"
		>
			<header className="plan-proposal-header">
				<GitBranch size={14} aria-hidden="true" />
				<strong>{pushApprovalQuestion(item)}</strong>
				<span className="plan-proposal-status">
					{state.answer === "pending" ? (
						working === "push" ? (
							"Pushing…"
						) : (
							"Waiting for you"
						)
					) : state.answer === "pushed" ? (
						<>
							<Check size={14} aria-hidden="true" />{" "}
							{pushAnswerLine(item.branch, state)}
						</>
					) : (
						<span title={state.detail || undefined}>
							{state.answer === "outdated"
								? "Outdated"
								: pushAnswerLine(item.branch, state)}
						</span>
					)}
				</span>
			</header>
			{item.summary ? (
				<div className="plan-proposal-body">
					<p title={item.summary}>{item.summary}</p>
				</div>
			) : null}
			{state.answer === "outdated" || state.answer === "failed" ? (
				<p className="secret-request-note">{state.detail}</p>
			) : null}
			{pending ? (
				<div className="plan-proposal-actions">
					{error ? <p className="secret-request-note">{error}</p> : null}
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled || working !== null}
						onClick={() => answer("cancel")}
					>
						Cancel
					</button>
					<button
						type="button"
						className="plan-proposal-approve"
						disabled={actions.disabled || working !== null}
						onClick={() => answer("push")}
					>
						{working === "push" ? "Pushing…" : "Push"}
					</button>
				</div>
			) : null}
		</section>
	);
}
