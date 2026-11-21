import type { ModelMessage } from "ai";
import { WorkspaceId } from "#/domain/ids";
import { SCRUB_MEMORY_CREDENTIAL } from "#/domain/memory-repo";
import type { SessionItem } from "#/domain/session-item";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import type { AgentToolWorkspace } from "../services/agent-tool-workspace";
import { turnMemory } from "../services/turn-memory";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";

/**
 * Cross-chat memory for a turn on a box (docs/turn-runner-boxes.md, "Memory
 * on a box"): the edge holds the memory repo's credentials and the
 * embedding keys, so every memory operation runs here, on the turn's own
 * chat and its own VM; the box adds the recalled parts to its messages. A
 * short-lived clone token prepareVm puts on the VM goes back to the box only
 * so tool output can be redacted, as the VM's scoped grant does.
 *
 * Each call builds the turn's memory afresh, never reusing one an earlier
 * request built: a TurnMemory holds promises (the prefetched line vectors),
 * and a Worker cannot settle a promise in a request other than the one that
 * created it ("This promise was created by a request that has since ended").
 * Nothing is lost: the snapshot and line vectors are warm per isolate, and
 * releaseVm finds every step's tokens in the ledger.
 */
export type MemoryPortCall = {
	readonly op:
		| "init"
		| "prepareVm"
		| "releaseVm"
		| "parts"
		| "recordSaved"
		| "afterTurn";
	readonly wording?: string;
	readonly writer?: string;
	readonly vm?: string | null;
	readonly scrub?: boolean;
	readonly cwd?: string;
	readonly messages?: ModelMessage[];
	readonly items?: SessionItem[];
};

export type TurnBoxMemoryDeps = {
	readonly machines?: () => WorkspaceMachines;
	readonly memory?: typeof turnMemory;
	readonly owner?: typeof agentSessionMetadataForOwner;
};

function memoryFor(
	owner: { id: string; userId: string; projectId: string | null },
	call: MemoryPortCall,
	deps: TurnBoxMemoryDeps,
) {
	return (deps.memory ?? turnMemory)(owner, {
		...(call.wording ? { wording: call.wording as never } : {}),
		...(call.writer ? { writer: call.writer as never } : {}),
	}).catch(() => null);
}

export async function memoryPort(
	turn: ApiTurn,
	call: MemoryPortCall,
	deps: TurnBoxMemoryDeps = {},
): Promise<unknown> {
	const chat = await (deps.owner ?? agentSessionMetadataForOwner)(
		turn.user_id,
		turn.session_id,
	);
	if (!chat) throw new TurnBoxPortForbidden("session");
	// The root builder only: helpers never run on a box.
	if (chat.parentSessionId) throw new TurnBoxPortForbidden("memory:helper");
	const memory = await memoryFor(
		{ id: chat.id, userId: turn.user_id, projectId: chat.projectId ?? null },
		call,
		deps,
	);
	/** The chat's own VM, never one the box names. */
	const workspace = (cwd = ""): AgentToolWorkspace => {
		if (!deps.machines) throw new TurnBoxPortForbidden("memory:machines");
		if (!chat.providerRef) throw new TurnBoxPortForbidden("memory:vm");
		return {
			machines: deps.machines(),
			vm: WorkspaceId(chat.providerRef),
			cwd,
		};
	};
	const ownVm = (vm: string | null | undefined) => {
		if (vm !== chat.providerRef) throw new TurnBoxPortForbidden("memory:vm");
	};
	switch (call.op) {
		case "init":
			return memory
				? { mode: memory.mode, instructions: memory.instructions }
				: null;
		case "prepareVm": {
			if (!memory) return { tokens: [] };
			ownVm(call.vm);
			const tokens: string[] = [];
			await memory.prepareVm(workspace(), (token) => tokens.push(token));
			return { tokens: [...new Set([...tokens, ...memory.vmTokens()])] };
		}
		case "releaseVm": {
			if (call.vm) ownVm(call.vm);
			const ws = call.vm ? workspace() : undefined;
			await memory?.releaseVm(ws);
			// Another isolate may have minted the token: scrub the clone anyway.
			if (ws && call.scrub)
				await ws.machines
					.exec(ws.vm, SCRUB_MEMORY_CREDENTIAL, 15_000)
					.catch(() => null);
			return null;
		}
		case "parts":
			if (!memory) return null;
			return memory.memoryParts(
				call.messages ?? [],
				call.items ?? [],
				async () => {
					if (call.cwd === undefined)
						throw new Error("The checkout is not ready yet.");
					return workspace(call.cwd);
				},
			);
		case "recordSaved":
			return memory ? memory.recordSaved(call.items ?? [], turn.id) : null;
		case "afterTurn":
			await memory?.afterTurn(turn.id);
			return null;
	}
}
