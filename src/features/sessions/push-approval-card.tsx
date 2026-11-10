import { Check, GitBranch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	type PushCardState,
	pushAnswerLine,
	pushApprovalQuestion,
} from "#/domain/push-approval";
import type { PushApprovalItem } from "#/domain/session-item";
import { createPushCardChecker } from "./push-card-checker";

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
	revision,
}: {
	item: PushApprovalItem;
	/** The answer the transcript shows (its notice), else pending. */
	outcome: PushCardState;
	actions?: PushApprovalActions;
	/** Changes when the chat's transcript or turn status does; a pending card then checks again. */
	revision?: string;
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
	// A pending card asks the server when shown, whenever the chat changes
	// after it, and every 30 s while the tab is visible, until settled.
	const checker = useRef<ReturnType<typeof createPushCardChecker> | null>(null);
	useEffect(() => {
		if (shownAnswer !== "pending" || !status) return;
		const next = createPushCardChecker({
			status: () => status(item.id),
			onState: setState,
			visible: () => document.visibilityState !== "hidden",
		});
		checker.current = next;
		void next.start();
		return () => {
			next.stop();
			checker.current = null;
		};
	}, [item.id, shownAnswer, status]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `revision` is the trigger: it changes with the chat's items and turn status.
	useEffect(() => {
		void checker.current?.check();
	}, [revision]);

	async function answer(kind: "push" | "cancel") {
		if (!actions || actions.disabled || working || state.answer !== "pending")
			return;
		setWorking(kind);
		setError(null);
		try {
			const next = await actions[kind](item.id);
			if (next.answer !== "pending") checker.current?.settle();
			setState(next);
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
