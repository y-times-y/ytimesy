import { WorkspaceId } from "#/domain/ids";
import { machineGitReleaseScript } from "#/domain/machine-git";
import { TurnBoxPortForbidden } from "#/domain/turn-box-protocol";
import { machineGitStep } from "../services/machine-git";
import type { WorkspaceMachines } from "../services/workspace-machines";
import { agentSessionMetadataForOwner } from "./agent-sessions";
import type { ApiTurn } from "./api-turns";
import { machineGitTokens } from "./machine-git-tokens";

/**
 * Plain git on the chat's VM for a turn on a box (docs/turn-runner-boxes.md,
 * "Everything a root chat uses, on a box"): the edge holds the git proxy's
 * signing secret, so it mints the step's machine token and sets git up on
 * the turn's own VM; the token goes back to the box only so tool output can
 * be redacted. Release removes it from the VM and revokes every token of the
 * chat, whichever request minted it, so it needs nothing kept between
 * requests.
 */
export type MachineGitPortCall = {
	readonly op: "prepareVm" | "releaseVm";
	readonly vm?: string | null;
};

export type TurnBoxMachineGitDeps = {
	readonly machines?: () => WorkspaceMachines;
	readonly step?: typeof machineGitStep;
	readonly tokens?: Pick<typeof machineGitTokens, "mint" | "revokeForSession">;
	readonly owner?: typeof agentSessionMetadataForOwner;
};

export async function machineGitPort(
	turn: ApiTurn,
	call: MachineGitPortCall,
	deps: TurnBoxMachineGitDeps = {},
): Promise<{ tokens: string[] } | null> {
	const chat = await (deps.owner ?? agentSessionMetadataForOwner)(
		turn.user_id,
		turn.session_id,
	);
	if (!chat) throw new TurnBoxPortForbidden("session");
	if (chat.parentSessionId) throw new TurnBoxPortForbidden("git:helper");
	const tokens = deps.tokens ?? machineGitTokens;
	const owner = { userId: turn.user_id, id: chat.id };
	/** The chat's own VM, never one the box names. */
	const workspace = (vm: string | null | undefined) => {
		if (!chat.providerRef || vm !== chat.providerRef)
			throw new TurnBoxPortForbidden("git:vm");
		if (!deps.machines) throw new TurnBoxPortForbidden("git:machines");
		return { machines: deps.machines(), vm: WorkspaceId(chat.providerRef) };
	};
	if (call.op === "prepareVm") {
		const ws = workspace(call.vm);
		const step = (deps.step ?? machineGitStep)(owner, tokens);
		if (!step) return { tokens: [] };
		const minted: string[] = [];
		await step.prepareVm(ws, (token) => minted.push(token));
		return { tokens: minted };
	}
	if (call.vm) {
		const ws = workspace(call.vm);
		await Promise.resolve()
			.then(() =>
				ws.machines.exec(ws.vm, machineGitReleaseScript(chat.id), 15_000),
			)
			.catch(() => {
				console.warn("Workspace git token could not be removed from the VM.");
			});
	}
	await tokens.revokeForSession(turn.user_id, chat.id).catch(() => {
		console.warn("Workspace git token could not be revoked; it expires soon.");
	});
	return null;
}
