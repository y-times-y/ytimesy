import { Check, GitBranch } from "lucide-react";
import { useState } from "react";
import {
	pushApprovalQuestion,
	pushApprovedText,
	pushCancelledText,
} from "#/domain/push-approval";
import type { PushApprovalItem } from "#/domain/session-item";

export type PushApprovalActions = {
	readonly disabled: boolean;
	/** Records the approval for this push; throws when it can no longer be approved. */
	readonly onApprove: (itemId: string) => Promise<void>;
	/** Sends the answer as the user's next message. */
	readonly onAnswer: (text: string) => void;
};

/**
 * The agent asked to push to the repository's default branch. Push approves
 * that exact push once and tells the agent to retry it; Cancel tells it to
 * leave the work on its branch.
 */
export function PushApprovalCard({
	item,
	outcome,
	actions,
}: {
	item: PushApprovalItem;
	outcome: "pending" | "approved" | "cancelled" | "answered";
	actions?: PushApprovalActions;
}) {
	const [approving, setApproving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pending = outcome === "pending" && actions;

	async function approve() {
		if (!actions || approving) return;
		setApproving(true);
		setError(null);
		try {
			await actions.onApprove(item.id);
			actions.onAnswer(pushApprovedText(item.branch));
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not approve the push.",
			);
		} finally {
			setApproving(false);
		}
	}

	return (
		<section
			className="plan-proposal"
			data-outcome={
				outcome === "approved" ? "approved" : pending ? "pending" : undefined
			}
			aria-label="Push approval"
		>
			<header className="plan-proposal-header">
				<GitBranch size={14} aria-hidden="true" />
				<strong>{pushApprovalQuestion(item)}</strong>
				<span className="plan-proposal-status">
					{outcome === "approved" ? (
						<>
							<Check size={14} aria-hidden="true" /> Approved
						</>
					) : outcome === "cancelled" ? (
						"Cancelled"
					) : outcome === "answered" ? (
						"Answered"
					) : (
						"Waiting for you"
					)}
				</span>
			</header>
			{item.summary ? (
				<div className="plan-proposal-body">
					<p title={item.summary}>{item.summary}</p>
				</div>
			) : null}
			{pending ? (
				<div className="plan-proposal-actions">
					{error ? <p className="secret-request-note">{error}</p> : null}
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled || approving}
						onClick={() => actions.onAnswer(pushCancelledText(item.branch))}
					>
						Cancel
					</button>
					<button
						type="button"
						className="plan-proposal-approve"
						disabled={actions.disabled || approving}
						onClick={approve}
					>
						{approving ? "Approving…" : "Push"}
					</button>
				</div>
			) : null}
		</section>
	);
}
