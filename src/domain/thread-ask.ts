import type {
	SecretRequestItem,
	SessionItem,
	UserQuestionItem,
} from "./session-item";

/** What a waiting thread asks the person, if it asks something an inline control can answer. */
export type ThreadAsk =
	| { readonly kind: "question"; readonly item: UserQuestionItem }
	| { readonly kind: "secret"; readonly item: SecretRequestItem };

/**
 * The open question or secret request of a thread: the newest one after the
 * person's last message (the same scan as `chatWaitingOn`). Null when there is
 * none, or when the thread waits on something else (a push or a plan needs
 * the thread's own card).
 */
export function openThreadAsk(items: readonly SessionItem[]): ThreadAsk | null {
	for (let index = items.length - 1; index >= 0; index--) {
		const item = items[index];
		if (!item || item.kind === "userMessage") return null;
		if (item.kind === "userQuestion") return { kind: "question", item };
		if (item.kind === "secretRequest") return { kind: "secret", item };
		if (item.kind === "pushApproval" || item.kind === "planProposal")
			return null;
	}
	return null;
}
