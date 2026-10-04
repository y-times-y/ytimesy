import { createHash } from "node:crypto";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createPostgresState } from "@chat-adapter/state-pg";
import { Chat, type Message, type Thread } from "chat";
import { slackMessage } from "#/domain/slack";
import { database } from "../adapters/database";
import { serverConfig } from "../config";
import { enqueueSlackMessage } from "../jobs/queue";
import { slackConfig } from "./config";

let instance: ReturnType<typeof createBot> | undefined;

function createBot() {
	const config = slackConfig();
	const slack = createSlackAdapter({
		clientId: config.SLACK_CLIENT_ID,
		clientSecret: config.SLACK_CLIENT_SECRET,
		signingSecret: config.SLACK_SIGNING_SECRET,
		encryptionKey: createHash("sha256")
			.update(`slack:${serverConfig().BETTER_AUTH_SECRET}`)
			.digest("base64"),
	});
	const bot = new Chat({
		userName: "ytimesy",
		adapters: { slack },
		state: createPostgresState({
			client: database(),
			autoCreateSchema: false,
			keyPrefix: "ytimesy-slack",
		}),
		logger: "silent",
	});
	const receive = async (thread: Thread, message: Message) => {
		if (
			message.author.isMe ||
			message.author.isBot !== false ||
			message.author.isSystem
		)
			return;
		const raw = message.raw as { team_id?: string; team?: string };
		const input = slackMessage.parse({
			installationId: raw.team_id ?? raw.team,
			threadId: thread.id,
			slackUserId: message.author.userId,
			messageId: message.id,
			text: message.text,
		});
		await enqueueSlackMessage(input);
		await thread.subscribe();
	};
	bot.onNewMention(receive);
	bot.onSubscribedMessage(receive);
	bot.onDirectMessage(receive);
	return { bot, slack };
}

export function slackBot() {
	instance ??= createBot();
	return instance;
}

export async function handleSlackWebhook(request: Request) {
	const tasks: Promise<unknown>[] = [];
	const response = await slackBot().bot.webhooks.slack(request, {
		waitUntil: (task) => {
			tasks.push(task);
		},
	});
	// Acknowledge only after durable enqueue; no VM work runs in this request.
	await Promise.all(tasks);
	return response;
}

export async function withSlackThread<T>(
	installationId: string,
	threadId: string,
	operation: (thread: Thread) => Promise<T>,
) {
	const { bot, slack } = slackBot();
	await bot.initialize();
	const installation = await slack.getInstallation(installationId);
	if (!installation)
		throw new Error("Slack installation is no longer available.");
	return slack.withBotToken(
		installation.botToken,
		() => operation(bot.thread(threadId)),
		{ installationId },
	);
}
