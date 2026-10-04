import { z } from "zod";

export const slackMessage = z.object({
	installationId: z.string().min(1),
	threadId: z.string().regex(/^slack:[A-Z0-9]+:[0-9.]+$/),
	slackUserId: z.string().regex(/^[A-Z0-9]+$/),
	messageId: z.string().min(1),
	text: z.string().max(40000),
});
export type SlackMessage = z.infer<typeof slackMessage>;

export function slackTaskText(text: string) {
	return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

export function slackCommand(
	text: string,
): "stop" | "status" | "disconnect" | "task" {
	const command = slackTaskText(text).toLowerCase();
	if (command === "stop" || command === "status" || command === "disconnect")
		return command;
	return "task";
}
