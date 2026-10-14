import { z } from "zod";
import { database } from "./database";

export type ModelFailoverPreferences = {
	/** Continue a turn on another route when its own is unavailable. */
	readonly enabled: boolean;
	/** Stop and ask before moving from a subscription onto a paid API key. */
	readonly askBeforePaid: boolean;
	/** Connection keys ("codex" or a model connection id), best first. */
	readonly connectionOrder: readonly string[];
};

export const DEFAULT_MODEL_FAILOVER_PREFERENCES: ModelFailoverPreferences = {
	enabled: true,
	askBeforePaid: false,
	connectionOrder: [],
};

export const connectionOrderSchema = z
	.array(z.union([z.literal("codex"), z.uuid()]))
	.max(64)
	.transform((keys) => [...new Set(keys)]);

export async function loadModelFailoverPreferences(
	userId: string,
): Promise<ModelFailoverPreferences> {
	const row = (
		await database().query<{
			enabled: boolean;
			ask_before_paid: boolean;
			connection_order: unknown;
		}>(
			"select enabled,ask_before_paid,connection_order from model_failover_preference where user_id=$1",
			[userId],
		)
	).rows[0];
	if (!row) return DEFAULT_MODEL_FAILOVER_PREFERENCES;
	const order = connectionOrderSchema.safeParse(row.connection_order);
	return {
		enabled: row.enabled,
		askBeforePaid: row.ask_before_paid,
		connectionOrder: order.success ? order.data : [],
	};
}

export async function saveModelFailoverPreferences(
	userId: string,
	preferences: ModelFailoverPreferences,
): Promise<void> {
	await database().query(
		`insert into model_failover_preference(user_id,enabled,ask_before_paid,connection_order)
		 values($1,$2,$3,$4::jsonb)
		 on conflict (user_id) do update set enabled=excluded.enabled,
		 ask_before_paid=excluded.ask_before_paid,connection_order=excluded.connection_order,updated_at=now()`,
		[
			userId,
			preferences.enabled,
			preferences.askBeforePaid,
			JSON.stringify(connectionOrderSchema.parse(preferences.connectionOrder)),
		],
	);
}
