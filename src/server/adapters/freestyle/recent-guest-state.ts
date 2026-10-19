import type { VmData } from "freestyle";
import {
	infrastructureAdmissionEnabled,
	recentAdmissionCovers,
} from "./usage-admission";

/**
 * A guest operation that just succeeded on a running VM stands in for the
 * provider read before the next one, for a few seconds: a VM with guest
 * activity that recent cannot have idle-paused (the idle timeout is minutes),
 * and the admission it ran under must still cover the next operation. Any
 * failed operation, lifecycle change or pause through this isolate forgets it,
 * and a paused or stopped VM is never remembered, so a resume always takes the
 * full read and admission path.
 */
const REUSE_MS = 10_000;
const recent = new Map<string, { data: VmData; at: number }>();

export function rememberRunningGuest(data: VmData, now = Date.now()) {
	if (data.state !== "running") return;
	recent.set(data.id, { data, at: now });
	if (recent.size > 500)
		for (const [id, entry] of recent)
			if (now - entry.at > REUSE_MS) recent.delete(id);
}

export function forgetRunningGuest(vmId: string) {
	recent.delete(vmId);
}

/** The read behind the last successful operation, while it still vouches for the next. */
export function recentlyRunningGuest(
	vmId: string,
	requiredSeconds: number,
	now = Date.now(),
) {
	const entry = recent.get(vmId);
	if (!entry) return undefined;
	if (now - entry.at > REUSE_MS || now < entry.at) {
		recent.delete(vmId);
		return undefined;
	}
	return !infrastructureAdmissionEnabled() ||
		recentAdmissionCovers(entry.data, requiredSeconds, now)
		? entry.data
		: undefined;
}
