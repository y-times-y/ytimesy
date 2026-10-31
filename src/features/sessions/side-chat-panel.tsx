import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import type { AgentProviderId } from "#/domain/agent-provider";
import { publicFailureMessage } from "#/domain/project-workspace";
import type { SessionTurnStatus } from "#/domain/session-item";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import {
	releaseQueuedSessionMessage,
	removeQueuedSessionMessage,
	stopCodexSessionTurn,
	updateQueuedSessionMessage,
} from "./codex-session.fn";
import { readSideChatFn, sendSideChatFn } from "./side-chat.fn";
import "./side-chat.css";

type SideSend = "sent" | "unsent";

/**
 * The side conversation's view and actions, for a second composer beside
 * Main. Sends go to the side session only; Main's turn and queue are never
 * touched.
 */
export function useSideChat({
	projectId,
	parent,
	harnessId,
}: {
	projectId?: string;
	parent: PublicCodexSession;
	harnessId: AgentProviderId;
}) {
	const queryClient = useQueryClient();
	const read = useServerFn(readSideChatFn);
	const send = useServerFn(sendSideChatFn);
	const stop = useServerFn(stopCodexSessionTurn);
	const remove = useServerFn(removeQueuedSessionMessage);
	const update = useServerFn(updateQueuedSessionMessage);
	const release = useServerFn(releaseQueuedSessionMessage);
	const [pending, setPending] = useState(false);
	const parentSessionId = parent.agentSessionId;
	const key = ["side-chat", projectId, parentSessionId] as const;
	const query = useQuery({
		queryKey: key,
		enabled: Boolean(projectId && parentSessionId),
		queryFn: () =>
			read({
				data: {
					projectId: projectId as string,
					parentSessionId: parentSessionId as string,
					harnessId,
				},
			}),
		refetchInterval: (current) =>
			current.state.data?.view?.turnStatus === "running" ? 1000 : false,
	});
	const view = query.data?.view ?? null;
	const sideSessionId = query.data?.sessionId ?? null;
	// Main's connection, models and readiness; the side chat's own transcript.
	const session: PublicCodexSession = {
		...parent,
		agentSessionId: sideSessionId,
		items: view?.items ?? [],
		turnStatus: view?.turnStatus ?? "idle",
		hasOlderItems: false,
		usage: view?.usage,
		listedModelId: view?.listedModelId || parent.listedModelId,
	};
	const apply = (next: { sessionId: string | null; view: unknown }) =>
		queryClient.setQueryData(key, next);
	const scope = () => ({
		projectId,
		harnessId,
		sessionId: sideSessionId ?? undefined,
	});
	const failed = (cause: unknown) => toast.error(publicFailureMessage(cause));
	const refresh = () => void queryClient.invalidateQueries({ queryKey: key });

	async function sendMessage(
		text: string,
		modelId: string,
		options?: {
			readonly reasoningId?: string;
			readonly speed?: string;
			readonly userMessageId?: string;
		},
	): Promise<SideSend> {
		if (!projectId || !parentSessionId) return "unsent";
		setPending(true);
		try {
			const sent = await send({
				data: {
					projectId,
					parentSessionId,
					harnessId,
					modelId,
					text,
					userMessageId: options?.userMessageId ?? crypto.randomUUID(),
					...(options?.reasoningId ? { variant: options.reasoningId } : {}),
					...(options?.speed === "fast" || options?.speed === "ultrafast"
						? { speed: options.speed }
						: {}),
				},
			});
			apply({ sessionId: sent.sideSessionId, view: sent.view });
			return "sent";
		} catch (cause) {
			failed(cause);
			return "unsent";
		} finally {
			setPending(false);
		}
	}

	return {
		session,
		pending,
		send: sendMessage,
		stop: () => {
			if (!sideSessionId) return;
			void stop({ data: scope() }).then(refresh, failed);
		},
		removeQueued: (messageId: string) =>
			void remove({ data: { ...scope(), messageId } }).then(refresh, failed),
		editQueued: (messageId: string, text: string) =>
			void update({ data: { ...scope(), messageId, text } }).then(
				refresh,
				failed,
			),
		sendQueued: (messageId: string, text?: string) =>
			void release({
				data: { ...scope(), messageId, ...(text ? { text } : {}) },
			}).then(refresh, failed),
	};
}

/** The Side chat tab of the right sidebar: one status line, then the chat. */
export function SideChatFrame({
	parentTurnStatus,
	children,
}: {
	parentTurnStatus: SessionTurnStatus;
	children: ReactNode;
}) {
	return (
		<section className="side-chat" aria-label="Side chat">
			<p className="side-chat-note">
				{parentTurnStatus === "running"
					? "Main is working. This chat does not interrupt it."
					: "Same agent as Main, in a separate conversation."}
			</p>
			<div className="side-chat-body">{children}</div>
		</section>
	);
}
