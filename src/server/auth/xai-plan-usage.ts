import {
	GROK_PLAN_USAGE_URL,
	type GrokPlanUsage,
	grokPlanUsageFromBilling,
	grokPlanUsageFromJson,
} from "#/domain/grok-plan-usage";
import { database } from "../adapters/database";
import { xaiOAuthJson } from "./xai-oauth";
import { xaiSubscriptionAccessToken } from "./xai-subscription";

/** How old the reading may get before opening the picker or Settings reads it again. */
export const GROK_PLAN_USAGE_REFRESH_SECONDS = 5 * 60;
const READ_TIMEOUT_MS = 4_000;
/** One read per user at a time in this isolate; the database claim covers the rest. */
const reads = new Map<string, Promise<GrokPlanUsage | null>>();

/**
 * The Grok plan's reading for the picker and Settings. When it is missing or
 * older than five minutes, one GET to the Grok CLI's billing endpoint reads
 * it afresh (it costs nothing from the plan). Claiming the read moves
 * plan_usage_at forward first, so every isolate waits five minutes after an
 * attempt, failed or not. On failure the last reading (or null) comes back;
 * a refusal there never marks the connection, since chats use api.x.ai.
 */
export function grokPlanUsageForPicker(
	userId: string,
	options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<GrokPlanUsage | null> {
	const running = reads.get(userId);
	if (running) return running;
	const read = readFresh(userId, options).finally(() => reads.delete(userId));
	reads.set(userId, read);
	return read;
}

async function readFresh(
	userId: string,
	options: { fetch?: typeof fetch; timeoutMs?: number },
): Promise<GrokPlanUsage | null> {
	const claimed = (
		await database().query<{ id: string }>(
			`update model_connection set plan_usage_at=now()
			 where user_id=$1 and kind='xai-subscription' and status='ready'
			 and (plan_usage_at is null or plan_usage_at < now() - make_interval(secs => $2))
			 returning id`,
			[userId, GROK_PLAN_USAGE_REFRESH_SECONDS],
		)
	).rows[0];
	if (!claimed) return readGrokPlanUsage(userId);
	let usage: GrokPlanUsage | null = null;
	try {
		const { token } = await xaiSubscriptionAccessToken(userId, claimed.id);
		const response = await (options.fetch ?? fetch)(GROK_PLAN_USAGE_URL, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/json",
				"user-agent": "ytimesy",
			},
			redirect: "manual",
			signal: AbortSignal.timeout(options.timeoutMs ?? READ_TIMEOUT_MS),
		});
		if (response.ok)
			usage = grokPlanUsageFromBilling(
				await xaiOAuthJson(response),
				Date.now(),
			);
		else {
			await response.body?.cancel().catch(() => undefined);
			console.warn("Grok plan usage read was refused.", {
				status: response.status,
			});
		}
	} catch (error) {
		console.warn("Grok plan usage could not be read from xAI.", {
			reason: error instanceof Error ? error.name : "unknown",
		});
	}
	if (!usage) return readGrokPlanUsage(userId);
	await database().query(
		`update model_connection set plan_usage=$3::jsonb,plan_usage_at=now()
		 where user_id=$1 and id=$2 and kind='xai-subscription'`,
		[userId, claimed.id, JSON.stringify(usage)],
	);
	return usage;
}

/** The latest reading while the plan is connected, or null when there is none. */
export async function readGrokPlanUsage(
	userId: string,
): Promise<GrokPlanUsage | null> {
	const row = (
		await database().query<{ plan_usage: unknown }>(
			`select plan_usage from model_connection
			 where user_id=$1 and kind='xai-subscription' and status='ready'`,
			[userId],
		)
	).rows[0];
	return grokPlanUsageFromJson(row?.plan_usage);
}
