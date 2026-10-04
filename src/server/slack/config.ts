import { z } from "zod";

const credentials = z.object({
	SLACK_CLIENT_ID: z.string().min(1),
	SLACK_CLIENT_SECRET: z.string().min(1),
	SLACK_SIGNING_SECRET: z.string().min(1),
});

export function slackConfig() {
	const result = credentials.safeParse(process.env);
	if (!result.success)
		throw new Response("Slack is not configured.", { status: 503 });
	return result.data;
}

export function slackConfigured() {
	return credentials.safeParse(process.env).success;
}
