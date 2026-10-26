import { Effect, Layer } from "effect";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { readFreestyleApiKey } from "./api-key";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

/**
 * One provider client per key for this Node process, instead of one per
 * server call: its HTTP/2 connection to the provider is then reused by every
 * Files read, exec and wake that follows, instead of each call paying a new
 * TLS handshake. On Workers the runtime pools outbound connections itself and
 * a client must not outlive its request (its fetch wrappers may hold that
 * request's I/O), so each call keeps its own client there.
 */
const shared = new Map<string, WorkspaceMachines>();

function onWorkers() {
	return (
		typeof navigator !== "undefined" &&
		navigator.userAgent === "Cloudflare-Workers"
	);
}

export function sharedFreestyleWorkspaceMachines(apiKey: string) {
	if (onWorkers()) return createFreestyleWorkspaceMachines(apiKey);
	let machines = shared.get(apiKey);
	if (!machines) {
		machines = createFreestyleWorkspaceMachines(apiKey);
		// A rotated key replaces the old client.
		shared.clear();
		shared.set(apiKey, machines);
	}
	return machines;
}

export const FreestyleWorkspaceMachinesLive = Layer.effect(
	WorkspaceMachineService,
	Effect.gen(function* () {
		const apiKey = yield* readFreestyleApiKey();
		return sharedFreestyleWorkspaceMachines(apiKey);
	}),
);
