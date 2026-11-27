import { alertHour } from "#/domain/owner-alerts";
import { recordInterruption } from "../interruption-events";
import { alertOwner } from "../owner-alerts";
import type { MachineRateLimitHit } from "./machine-failure";

/**
 * One provider limit hit (Freestyle 429 LIMIT_EXCEEDED on a machine call):
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
			await (deps.record ?? recordInterruption)({
				kind: "machine.rate_limited",
				sessionId: hit.slug,
				cause: `${hit.operation} attempt ${hit.attempt}${hit.limit ? ` (${hit.limit})` : ""}`,
				recovered: true,
				userVisible: false,
			});
			await (deps.alert ?? alertOwner)({
				kind: "provider-account-limit",
				key: alertHour(deps.now),
				subject: "ytimesy: the machine provider's account limit was hit",
				text: 'Freestyle answered 429 (account resource limit) to a machine start. Users see "Starting machine…" while it retries for up to 15 minutes. Free machines (pause or delete idle ones); the storage alerts are owned by the retention work. Further hits this hour are not emailed; each is an interruption_event row (kind machine.rate_limited).',
			});
		} catch {
			console.warn("Machine rate limit report failed.");
		}
	})();
}
