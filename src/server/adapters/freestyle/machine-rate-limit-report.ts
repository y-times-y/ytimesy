import { alertHour } from "#/domain/owner-alerts";
import { recordInterruption } from "../interruption-events";
import { alertOwner } from "../owner-alerts";
import type { MachineRateLimitHit } from "./machine-failure";

/**
 * One provider limit hit (a Freestyle 429 on a machine call: an account limit, or the provider's own capacity):
 * an interruption_event row, and an owner email at most once an hour, so the
 * account limit is seen before a user is. Never throws; never awaited.
 */
export function reportMachineRateLimit(
	hit: MachineRateLimitHit,
	deps: {
		record?: typeof recordInterruption;
		alert?: typeof alertOwner;
		now?: Date;
	} = {},
): Promise<void> {
	return (async () => {
		try {
			const capacity = hit.limit === "provider-capacity";
			await (deps.record ?? recordInterruption)({
				kind: capacity ? "machine.provider_capacity" : "machine.rate_limited",
				sessionId: hit.slug,
				cause: `${hit.operation} attempt ${hit.attempt}${hit.limit ? ` (${hit.limit})` : ""}`,
				recovered: true,
				userVisible: false,
			});
			await (deps.alert ?? alertOwner)(
				capacity
					? {
							kind: "provider-capacity",
							key: alertHour(deps.now),
							subject:
								"ytimesy: Freestyle is at capacity (machine start delayed)",
							text: 'Freestyle answered 429 "server is at capacity; try again shortly" to a machine start. This is the provider\'s own host capacity, not one of our account limits (running VMs, machines, disk). Users see "Starting machine…" while we retry with jittered backoff (up to about 90 seconds per start, honouring Retry-After). Nothing to free on our side. If it persists for hours, contact Freestyle support with the request ids from the logs. Further hits this hour are not emailed; each is an interruption_event row (kind machine.provider_capacity).',
						}
					: {
							kind: "provider-account-limit",
							key: alertHour(deps.now),
							subject: "ytimesy: the machine provider's account limit was hit",
							text: `Freestyle answered 429 to a machine start${hit.limit && hit.limit !== "unspecified" ? ` (limit: ${hit.limit})` : " (the response did not name the limit)"}. Users see "Starting machine…" while it retries. If the limit is storage or running machines, free machines (pause or delete idle ones); the storage alerts are owned by the retention work. Further hits this hour are not emailed; each is an interruption_event row (kind machine.rate_limited).`,
						},
			);
		} catch {
			console.warn("Machine rate limit report failed.");
		}
	})();
}
