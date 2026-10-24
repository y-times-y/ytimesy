import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	isPastedText,
	PASTED_TEXT_PREVIEW_CHARACTERS,
} from "#/domain/pasted-text";
import { sessionItemsFromUnknown } from "#/domain/session-item";
import { requireUser } from "#/server/auth/auth";

const pastedTextRef = z.object({
	sessionId: z.string().uuid(),
	attachmentId: z.string().uuid(),
});

/** A sent message's pasted text, for its chip's preview. */
export const readPastedTextFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => pastedTextRef.parse(data))
	.handler(async ({ data }) => {
		const user = await requireUser(getRequest().headers);
		const [{ agentSessionForOwner }, { pastedTextContent }] = await Promise.all(
			[
				import("#/server/adapters/agent-sessions"),
				import("#/server/services/message-attachments"),
			],
		);
		const session = await agentSessionForOwner(user.id, data.sessionId);
		const attachment = sessionItemsFromUnknown(session?.items)
			.flatMap((item) =>
				item.kind === "userMessage" ? (item.attachments ?? []) : [],
			)
			.find((candidate) => candidate.id === data.attachmentId);
		if (!session || !attachment || !isPastedText(attachment))
			throw new Error("That pasted text is unavailable.");
		const text = await pastedTextContent(user.id, session.id, attachment);
		return {
			text: text.slice(0, PASTED_TEXT_PREVIEW_CHARACTERS),
			truncated: text.length > PASTED_TEXT_PREVIEW_CHARACTERS,
		};
	});
