import { Check, ListChecks } from "lucide-react";
import type { PlanProposalItem } from "#/domain/session-item";
import { AgentMarkdown } from "./agent-markdown";

export type PlanActions = {
	readonly disabled: boolean;
	readonly onApprove: () => void;
	readonly onRevise: () => void;
};

/** A plan the agent proposed; edits stay locked until the user approves it. */
export function PlanProposalCard({
	item,
	outcome,
	actions,
	onOpenFile,
}: {
	item: PlanProposalItem;
	outcome: "pending" | "approved" | "revised";
	actions?: PlanActions;
	onOpenFile?: (path: string) => void;
}) {
	return (
		<section
			className="plan-proposal"
			data-outcome={outcome}
			aria-label="Proposed plan"
		>
			<header className="plan-proposal-header">
				<ListChecks size={14} aria-hidden="true" />
				<strong>Proposed plan</strong>
				<span className="plan-proposal-status">
					{outcome === "approved" ? (
						<>
							<Check size={12} aria-hidden="true" /> Approved
						</>
					) : outcome === "revised" ? (
						"Feedback sent"
					) : (
						"Waiting for your approval"
					)}
				</span>
			</header>
			<div className="plan-proposal-body">
				<AgentMarkdown text={item.text} onOpenFile={onOpenFile} />
			</div>
			{outcome === "pending" && actions ? (
				<footer className="plan-proposal-actions">
					<p>No files change until you approve.</p>
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled}
						onClick={actions.onRevise}
					>
						Revise
					</button>
					<button
						type="button"
						className="plan-proposal-approve"
						disabled={actions.disabled}
						onClick={actions.onApprove}
					>
						Approve and build
					</button>
				</footer>
			) : null}
		</section>
	);
}
