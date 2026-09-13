import { Effect, Layer } from "effect";
import { WorkspaceMachineService } from "#/server/services/capabilities";
import { readFreestyleApiKey } from "./api-key";
import { createFreestyleWorkspaceMachines } from "./workspace-machines";

export const FreestyleWorkspaceMachinesLive = Layer.effect(
	WorkspaceMachineService,
	Effect.gen(function* () {
		const apiKey = yield* readFreestyleApiKey();
		return createFreestyleWorkspaceMachines(apiKey);
	}),
);
