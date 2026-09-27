import { REMOVE_CODEX_CREDENTIAL_FILES } from "#/server/adapters/codex/credential-files";
import type { WorkspaceRuntime } from "#/server/adapters/workspace-runtime";

/** Legacy project VMs may have been cloned from a login image. */
export async function removeCodexCredentialsFromProjectTemplate(
	runtime: WorkspaceRuntime,
	providerRef: string,
) {
	const result = await runtime.exec(
		providerRef,
		["bash", "-lc", REMOVE_CODEX_CREDENTIAL_FILES],
		{},
		15_000,
	);
	if (result.exitCode !== 0) {
		throw new Error("Could not remove Codex login from the project template.");
	}
}
