import { Effect } from "effect";
import { WorkspaceId } from "../../domain/ids";
import { UsageWindowExhausted } from "../../domain/infrastructure-usage";
import { budgetAdmission } from "../edge/budget-admission";
import type { EdgeExecutorEnvironment } from "../edge/environment";
import type { TurnBoxVmOps } from "../edge/turn-box-vm-routes";
import { deferredApiTurnWorkspace } from "../services/api-turn-workspace";
import type { BoxToolIdentityStore } from "../services/claude-box-tool-grant";
import { loadAgentProjectSecrets } from "../services/project-secrets";
import { machinesForAgentSession } from "../services/session-workspace-machines";
import { attemptThinkingPause } from "../services/thinking-pause";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import {
	clearTurnBoxToolIdentity,
	otherRunningTurnOnMachine,
	recordTurnBoxToolIdentity,
	turnBoxToolIdentity,
} from "./api-turns";
import { readFreestyleApiKey } from "./freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "./freestyle/workspace-machines";
import { assertUsageWindowsOpen } from "./infrastructure-usage";

/**
 * The database/Freestyle side of `vm/*` for the Worker. The Freestyle account
 * key is read here, on the edge, and lives only in `machines`; no function of
 * this object returns it. `scope` opens the request's database scope around
 * each call (withDatabaseScope), as turn-box-edge.ts does.
 *
 * NEVER RUN against real Freestyle, Postgres or a Worker: composed from the
 * existing admission and workspace code and exercised only through fakes.
 */
export function createTurnBoxVmOps(
	scope: <T>(run: () => Promise<T>) => Promise<T>,
	env: Pick<EdgeExecutorEnvironment, "USER_HUBS">,
	options: {
		readonly machines?: () => TurnBoxVmOps["machines"];
	} = {},
): TurnBoxVmOps {
	let cached: TurnBoxVmOps["machines"] | undefined;
	const accountMachines = () =>
		(cached ??=
			options.machines?.() ??
			createFreestyleWorkspaceMachines(Effect.runSync(readFreestyleApiKey())));
	const session = (userId: string, sessionId: string) =>
		scope(() => agentSessionMetadataForOwner(userId, sessionId));
	return {
		get machines() {
			return accountMachines();
		},
		allowRuntimeSecrets: () =>
			process.env.YTIMESY_CLAUDE_BOX_TOOLS_SECRETS === "1",
		currentVm: async (turn) =>
			(await session(turn.user_id, turn.session_id))?.providerRef ?? null,
		prepare: async (turn) => {
			const owner = await session(turn.user_id, turn.session_id);
			if (!owner) throw new Error("Task no longer exists.");
			const machines = machinesForAgentSession(accountMachines(), owner);
			const ready = await scope(() =>
				deferredApiTurnWorkspace(
					machines,
					{ ...owner, items: [] },
					new AbortController().signal,
				)(),
			);
			return ready.vm;
		},
		admit: async (turn) => {
			try {
				await scope(() => assertUsageWindowsOpen(turn.user_id));
			} catch (error) {
				if (error instanceof UsageWindowExhausted)
					return {
						ok: false,
						reason: "usage-window",
						message: error.message,
					};
				throw error;
			}
			const budget = await budgetAdmission(env, turn.user_id);
			return budget.action === "hold"
				? {
						ok: false,
						reason: "budget",
						message: budget.message ?? "The compute budget is used up.",
					}
				: { ok: true };
		},
		hasRuntimeSecrets: async (turn) => {
			const owner = await session(turn.user_id, turn.session_id);
			if (!owner?.projectId) return false;
			const projectId = owner.projectId;
			try {
				const secrets = await scope(() =>
					loadAgentProjectSecrets(turn.user_id, projectId),
				);
				return secrets.redact.length > 0;
			} catch {
				// Unreadable: treated as having secrets (the box stays off).
				return true;
			}
		},
		identityStore: (turn): BoxToolIdentityStore => ({
			current: () =>
				scope(() => turnBoxToolIdentity(turn.id, turn.lease_id ?? null)),
			record: (identityId) =>
				turn.lease_id
					? scope(() =>
							recordTurnBoxToolIdentity(
								turn.id,
								turn.lease_id as string,
								identityId,
							),
						)
					: Promise.resolve(false),
			clear: (identityId) =>
				scope(() => clearTurnBoxToolIdentity(turn.id, identityId)),
		}),
		pause: (turn, vm, facts) =>
			attemptThinkingPause({
				vm: WorkspaceId(vm),
				machines: accountMachines(),
				otherTurnOnMachine: (target) =>
					scope(() => otherRunningTurnOnMachine(turn.user_id, turn.id, target)),
				toolsRunning: () => facts.toolsRunning,
				current: () => true,
				quietSince: facts.quietSince,
			}),
	};
}
