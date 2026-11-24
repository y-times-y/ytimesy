import { parseClaudeCodeRouteId } from "#/domain/claude-code-route";
import {
	planBlocksWake,
	type WakeSkipReason,
	Y_WAKES_PER_USER_PER_DAY,
} from "#/domain/y-default";
import { readClaudePlanUsage } from "../adapters/claude-subscription";
import { consumeUserWake } from "../adapters/y-mode";
import {
	NoModelConnectedError,
	resolveLinkedChatRoute,
} from "./linked-chat-route";

export type WakeGate =
	| {
			readonly ok: true;
			readonly harnessId: "codex" | "api";
			readonly modelId: string;
	  }
	| { readonly ok: false; readonly reason: WakeSkipReason };

export type WakeGateDeps = {
	readonly route: typeof resolveLinkedChatRoute;
	readonly claudePlanUsage: typeof readClaudePlanUsage;
	readonly consumeWake: (userId: string, cap: number) => Promise<boolean>;
};

const liveDeps: WakeGateDeps = {
	route: resolveLinkedChatRoute,
	claudePlanUsage: readClaudePlanUsage,
	consumeWake: consumeUserWake,
};

/**
 * Whether Y² may take a model turn for a proactive wake now. Y² is on for
 * everyone, so this is what keeps it harmless: it runs only on a model the
 * person connected themselves (never ours), skips quietly (no turn, no error,
 * no cost) while none is connected or while their Claude plan is nearly full,
 * and stops at the user's daily wake cap across all projects. The cheap
 * checks run first, so a skipped wake never counts against the cap.
 */
export async function yWakeGate(
	input: {
		readonly userId: string;
		readonly harnessId: "codex" | "api";
		readonly listedModelId: string | null;
	},
	deps: WakeGateDeps = liveDeps,
): Promise<WakeGate> {
	let route: { harnessId: "codex" | "api"; modelId: string };
	try {
		const resolved = await deps.route({
			userId: input.userId,
			harnessId: input.harnessId,
			modelId: input.listedModelId ?? "",
		});
		route = {
			harnessId: resolved.harnessId === "codex" ? "codex" : "api",
			modelId: resolved.modelId,
		};
	} catch (error) {
		if (error instanceof NoModelConnectedError)
			return { ok: false, reason: "no-model" };
		throw error;
	}
	if (parseClaudeCodeRouteId(route.modelId)) {
		const usage = await deps.claudePlanUsage(input.userId).catch(() => null);
		if (planBlocksWake(usage))
			return { ok: false, reason: "plan-nearly-exhausted" };
	}
	if (!(await deps.consumeWake(input.userId, Y_WAKES_PER_USER_PER_DAY)))
		return { ok: false, reason: "user-daily-cap" };
	return { ok: true, ...route };
}
