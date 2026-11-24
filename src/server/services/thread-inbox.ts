import { Effect } from "effect";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { openThreadAsk, type ThreadAsk } from "#/domain/thread-ask";
import {
	agentSessionMetadataForOwner,
	agentSessionPageForOwner,
} from "../adapters/agent-sessions";
import { sendComposerMessage } from "./queued-user-messages";
import type { WorkspaceMachines } from "./workspace-machines";

/** Longest answer the Super agent's inbox sends. */
export const INBOX_ANSWER_LIMIT = 4_000;

type Metadata = typeof agentSessionMetadataForOwner;
type Send = (
	machines: WorkspaceMachines,
	...args: Parameters<typeof sendComposerMessage> extends [unknown, ...infer R]
		? R
		: never
) => Promise<{ readonly turnStatus: string }>;

/** A root thread of this project that is the person's own, not a subagent. */
async function ownThread(
	metadata: Metadata,
	userId: string,
	projectId: string,
	threadId: string,
) {
	const chat = await metadata(userId, threadId);
	if (
		!chat ||
		chat.projectId !== projectId ||
		chat.parentSessionId ||
		chat.agentRole
	)
		return null;
	return chat;
}

/**
 * The open question or secret request of one of the person's threads: its
 * last turn's page of the transcript, read only when the person opens the
 * inbox row (never on a timer).
 */
export async function readThreadAsk(
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly threadId: string;
	},
	deps: {
		readonly metadata: Metadata;
		readonly page: typeof agentSessionPageForOwner;
	} = {
		metadata: agentSessionMetadataForOwner,
		page: agentSessionPageForOwner,
	},
): Promise<ThreadAsk | null> {
	if (
		!(await ownThread(
			deps.metadata,
			input.userId,
			input.projectId,
			input.threadId,
		))
	)
		return null;
	const page = await deps.page(input.userId, input.threadId, { turns: 1 });
	return page ? openThreadAsk(sessionItemsFromUnknown(page.items)) : null;
}

/**
 * Sends the person's own answer (a chosen option, "Retry") to a thread
 * through the composer's Send path: it queues behind a running turn and
 * starts one for an idle thread. Never through Y²'s model, and never a secret
 * value (secrets are saved by their own function; the text only names them).
 */
export async function answerThread(
	machines: WorkspaceMachines,
	input: {
		readonly userId: string;
		readonly projectId: string;
		readonly threadId: string;
		readonly text: string;
		readonly idempotencyKey?: string;
	},
	deps: { readonly metadata: Metadata; readonly send: Send } = {
		metadata: agentSessionMetadataForOwner,
		send: (m, scope, message) =>
			Effect.runPromise(sendComposerMessage(m, scope, message)),
	},
): Promise<
	| { readonly ok: true; readonly turnStatus: string }
	| { readonly ok: false; readonly error: string }
> {
	const text = input.text.trim().slice(0, INBOX_ANSWER_LIMIT);
	if (!text) return { ok: false, error: "Nothing to send." };
	const chat = await ownThread(
		deps.metadata,
		input.userId,
		input.projectId,
		input.threadId,
	);
	if (!chat) return { ok: false, error: "No such thread in this project." };
	if (!chat.listedModelId)
		return { ok: false, error: "Open the thread to answer it." };
	const sent = await deps.send(
		machines,
		{
			userId: input.userId,
			projectId: input.projectId,
			sessionId: chat.id,
			harnessId: chat.harness,
			createNew: false,
		},
		{
			text,
			modelId: chat.listedModelId,
			...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
		},
	);
	return { ok: true, turnStatus: sent.turnStatus };
}
