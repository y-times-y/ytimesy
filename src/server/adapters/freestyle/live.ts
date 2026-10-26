import { Effect, Layer } from "effect";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import type { WorkspaceMachines } from "#/server/services/workspace-machines";
import { readFreestyleApiKey } from "./api-key";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

/**
 * One provider client per key for this process or isolate, instead of one
 * per server call: on Node its HTTP/2 connection to the provider is then
 * reused by every Files read, exec and wake that follows, instead of each
 * call paying a new TLS handshake. The client holds no request-scoped I/O
 * (on Workers each call is a plain fetch), so sharing it is safe there too.
 */
const shared = new Map<string, WorkspaceMachines>();

export function sharedFreestyleWorkspaceMachines(apiKey: string) {
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
