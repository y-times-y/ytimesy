import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import type { ModelSwitchItem, SessionItem } from "#/domain/session-item";

export type FailoverActions = {
	readonly disabled: boolean;
	/** Sends a follow-up that continues the turn on this route (`<connection>|<model>`). */
	readonly onContinue: (key: string) => void;
};

/** The user already sent another message after this item. */
export function answeredAfter(
	items: readonly SessionItem[],
	id: SessionItem["id"],
): boolean {
	const index = items.findIndex((item) => item.id === id);
	return (
		index >= 0 &&
		items.slice(index + 1).some((item) => item.kind === "userMessage")
	);
}

/**
 * A turn stopped before moving from a subscription onto a paid API key,
 * because the user asked to be asked first. Continue sends a follow-up that
 * runs on that fallback; Wait leaves the chat as it is, and the next message
 * tries the chosen model again.
 */
export function ModelSwitchCard({
	item,
	answered,
	actions,
}: {
	item: ModelSwitchItem;
	answered: boolean;
	actions?: FailoverActions;
}) {
	const [waiting, setWaiting] = useState(false);
	const pending = !answered && !waiting && actions;
	return (
		<section
			className="plan-proposal"
			data-outcome={pending ? "pending" : undefined}
			aria-label="Model unavailable"
		>
			<header className="plan-proposal-header">
				<ArrowLeftRight size={14} aria-hidden="true" />
				<strong>{item.from.connection} is unavailable</strong>
				<span className="plan-proposal-status">
					{answered
						? "Answered"
						: waiting
							? "Waiting"
							: "Waiting for your answer"}
				</span>
			</header>
			<div className="plan-proposal-body">
				<p>{item.message}</p>
				{waiting ? (
					<p>
						Your next message tries {item.from.model} on {item.from.connection}{" "}
						again.
					</p>
				) : null}
			</div>
			{pending ? (
				<footer className="plan-proposal-actions">
					<p>Nothing is billed until you continue.</p>
					<button
						type="button"
						className="plan-proposal-revise"
						disabled={actions.disabled}
						onClick={() => setWaiting(true)}
					>
						Wait
					</button>
					<button
						type="button"
						className="plan-proposal-approve"
						disabled={actions.disabled}
						onClick={() => actions.onContinue(item.to.key)}
					>
						Continue on {item.to.model} via {item.to.connection}
					</button>
				</footer>
			) : null}
		</section>
	);
}
