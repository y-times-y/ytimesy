import type { FirstTouch } from "#/domain/referral-attribution";
import { database } from "./database";

/**
 * Stores where an account first came from. Written once, at sign-up; a row
 * that already exists is never overwritten, so the first touch stays.
 */
export async function recordUserAttribution(userId: string, touch: FirstTouch) {
	await database().query(
		`insert into user_attribution(user_id,ref,utm_source,utm_medium,utm_campaign,utm_content,utm_term,referrer_host,landing_path,first_seen_at)
		 values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(user_id) do nothing`,
		[
			userId,
			touch.ref ?? null,
			touch.utm_source ?? null,
			touch.utm_medium ?? null,
			touch.utm_campaign ?? null,
			touch.utm_content ?? null,
			touch.utm_term ?? null,
			touch.referrer_host ?? null,
			touch.landing_path ?? null,
			touch.at,
		],
	);
}
