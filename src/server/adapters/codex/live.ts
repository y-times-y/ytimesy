import { Effect, Layer } from "effect";
import {
	CodexAppServer,
	WorkspaceMachineService,
} from "#/server/services/capabilities";
import { installAndProbeDeviceCode } from "./app-server";

export const CodexAppServerLive = Layer.effect(
	CodexAppServer,
	Effect.gen(function* () {
		const machines = yield* WorkspaceMachineService;
		return {
			installAndProbeDeviceCode: (workspaceId) =>
				installAndProbeDeviceCode(machines, workspaceId),
		};
	}),
);
