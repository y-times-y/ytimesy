import {
	machineGitReleaseScript,
	machineGitSetupScript,
} from "#/domain/machine-git";
import { MODEL_WORKFLOW_DEADLINE_MS } from "#/domain/model-workflow";
import { gitProxyConfiguration } from "../adapters/github/git-proxy-transfer";
import { machineGitTokens } from "../adapters/machine-git-tokens";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/** Like the memory clone's token: the step's deadline and a few minutes. */
const MACHINE_TOKEN_TTL_MS = MODEL_WORKFLOW_DEADLINE_MS + 5 * 60_000;

type Workspace = Pick<AgentToolWorkspace, "machines" | "vm">;

export type MachineGitStep = {
	/**
	 * Mints this step's machine token and sets plain git up on the VM.
	 * `beforeVm` gets the token before it reaches the VM, for redaction.
	 * Never fails: git without it behaves as it did before.
	 */
	prepareVm(
		workspace: Workspace,
		beforeVm?: (token: string) => void,
	): Promise<void>;
	/** Revokes the chat's tokens and removes this one from the VM (when the step has it); never fails. */
	releaseVm(workspace?: Workspace): Promise<void>;
};

/** Plain git for one chat's step; null when the git proxy is not configured. */
export function machineGitStep(
	owner: { userId: string; id: string },
	tokens: Pick<
		typeof machineGitTokens,
		"mint" | "revokeForSession"
	> = machineGitTokens,
): MachineGitStep | null {
	let proxy: ReturnType<typeof gitProxyConfiguration>;
	try {
		proxy = gitProxyConfiguration();
	} catch {
		// A misconfigured proxy fails the server's own transfers loudly; here git just stays as it was.
		return null;
	}
	if (!proxy) return null;
	const { origin } = proxy;
	let minted = false;
	return {
		async prepareVm(workspace, beforeVm) {
			try {
				const token = await tokens.mint({
					userId: owner.userId,
					sessionId: owner.id,
					expiresAt: new Date(Date.now() + MACHINE_TOKEN_TTL_MS),
				});
				minted = true;
				beforeVm?.(token);
				const result = await workspace.machines.exec(
					workspace.vm,
					machineGitSetupScript({
						origin,
						sessionId: owner.id,
						token,
					}),
					30_000,
				);
				if (result.exitCode !== 0)
					console.warn("Workspace git setup failed on the VM.", {
						exitCode: result.exitCode,
					});
			} catch (error) {
				console.warn("Workspace git setup could not start.", {
					error: error instanceof Error ? error.name : "unknown",
				});
			}
		},
		async releaseVm(workspace) {
			if (workspace && minted)
				await workspace.machines
					.exec(workspace.vm, machineGitReleaseScript(owner.id), 15_000)
					.catch(() => {
						console.warn(
							"Workspace git token could not be removed from the VM.",
						);
					});
			minted = false;
			// Any step's token of this chat, whichever isolate minted it.
			await tokens.revokeForSession(owner.userId, owner.id).catch(() => {
				console.warn(
					"Workspace git token could not be revoked; it expires soon.",
				);
			});
		},
	};
}
