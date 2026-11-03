import type { OwnerAlert } from "#/domain/owner-alerts";
import { redactErrorText } from "./analytics";
import { database } from "./database";
import { sendOperationalEmail } from "./email";

const DEFAULT_ALERT_EMAIL = "het@ytimesy.com";

/** Production alerts the owner; other environments only when asked to. */
export function ownerAlertsEnabled(
	env: Readonly<Record<string, string | undefined>> = process.env,
) {
	return (
		env.YTIMESY_ENVIRONMENT === "production" ||
		env.YTIMESY_OWNER_ALERTS === "true"
	);
}

/**
 * Emails the owner (YTIMESY_ALERT_EMAIL, default het@ytimesy.com) about an
 * operational problem, at most once per alert kind and key. Best effort: an
 * alert must never fail the job that raised it.
 */
export async function alertOwner(
	alert: OwnerAlert,
	deps: {
		claim?: (alert: OwnerAlert) => Promise<boolean>;
		send?: typeof sendOperationalEmail;
	} = {},
): Promise<"sent" | "duplicate" | "disabled" | "failed"> {
	if (!ownerAlertsEnabled()) return "disabled";
	try {
		const claimed = await (deps.claim ?? claimAlert)(alert);
		if (!claimed) return "duplicate";
		const text = `${alert.text}\n\nEnvironment: ${process.env.YTIMESY_ENVIRONMENT ?? "unknown"}\nAlert: ${alert.kind} (${alert.key})`;
		const sent = await (deps.send ?? sendOperationalEmail)({
			to: process.env.YTIMESY_ALERT_EMAIL?.trim() || DEFAULT_ALERT_EMAIL,
			subject: alert.subject.slice(0, 200),
			text,
			html: `<pre style="font:14px/1.5 ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
		});
		if (!sent) {
			console.warn("Owner alert not sent: no email sender.", {
				kind: alert.kind,
			});
			return "failed";
		}
		return "sent";
	} catch {
		console.warn("Owner alert failed.", { kind: alert.kind, key: alert.key });
		return "failed";
	}
}

/**
 * The owner_alert row is the claim: it holds across isolates and
 * invocations. When the insert fails the claim falls back to the Workers
 * cache (shared across isolates), so the owner is alerted once per key
 * rather than never or on every tick.
 */
export async function claimAlert(alert: OwnerAlert) {
	try {
		const result = await database().query(
			"insert into owner_alert(kind,dedupe_key,subject) values($1,$2,$3) on conflict do nothing returning 1",
			[alert.kind, alert.key.slice(0, 200), alert.subject.slice(0, 200)],
		);
		return (result.rowCount ?? result.rows.length) > 0;
	} catch (error) {
		console.warn("Owner alert not claimed in the database; using the cache.", {
			kind: alert.kind,
			key: alert.key,
			reason: redactErrorText(
				error instanceof Error
					? `${error.name}: ${error.message}`
					: String(error),
			).slice(0, 300),
		});
		// The owner is still alerted: the Workers cache is shared by every
		// isolate in the location the cron runs in, so it still sends once per
		// key. Without a cache (Node), it sends rather than staying silent.
		return claimInCache(alert).catch(() => true);
	}
}

/** One claim per alert key in the Workers cache, for a day. */
async function claimInCache(alert: OwnerAlert) {
	const cacheStorage = (globalThis as { caches?: { default?: Cache } }).caches
		?.default;
	if (!cacheStorage) return true;
	const key = new Request(
		`https://owner-alerts.ytimesy.internal/${encodeURIComponent(`${alert.kind}:${alert.key}`)}`,
	);
	if (await cacheStorage.match(key)) return false;
	await cacheStorage.put(
		key,
		new Response("claimed", {
			headers: { "cache-control": "max-age=86400" },
		}),
	);
	return true;
}

function escapeHtml(text: string) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}
