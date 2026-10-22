import { posix } from "node:path";
import { posixShellCommand } from "#/domain/posix-command";
import {
	pinVerificationBaseline,
	readVerificationBaseline,
} from "../adapters/turn-verification";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/**
 * Only a pristine initial checkout establishes policy; legacy dirty tasks fail
 * closed. A writer subagent's fork is never pristine: it starts from its
 * parent's working tree, which the runtime commits as the fork base and
 * records server-side (agent_fork.base). The fork takes its parent's pinned
 * baseline for the same directory when there is one; a parent that pins
 * none (a hard-set root chat is read-only) hands down the recorded fork
 * base. Either commit must be in the fork.
 */
export async function establishVerificationBaselines(
	input: AgentToolWorkspace & {
		userId: string;
		sessionId: string;
		additionalRepositoryNames?: readonly string[];
		/** A forked writer: its parent session and its recorded fork base. */
		forkedFrom?: { parentSessionId: string; forkBase: string };
	},
) {
	for (const directory of [
		input.cwd,
		...(input.additionalRepositoryNames ?? []).map((name) =>
			posix.join(posix.dirname(input.cwd), name),
		),
	]) {
		if (
			await readVerificationBaseline(input.userId, input.sessionId, directory)
		)
			continue;
		const inherited = input.forkedFrom
			? ((await readVerificationBaseline(
					input.userId,
					input.forkedFrom.parentSessionId,
					directory,
				)) ?? (directory === input.cwd ? input.forkedFrom.forkBase : null))
			: null;
		if (inherited) {
			const present = await input.machines.exec(
				input.vm,
				posixShellCommand([
					"git",
					"-C",
					directory,
					"cat-file",
					"-e",
					`${inherited}^{commit}`,
				]),
				15000,
			);
			if (present.exitCode)
				throw new Error(
					"The fork does not carry its parent's verification baseline. Existing edits were preserved.",
				);
			await pinVerificationBaseline(
				input.userId,
				input.sessionId,
				directory,
				inherited,
			);
			continue;
		}
		// No optional locks: the status check must not refresh (and so lock)
		// the index while the turn's code point (git write-tree, which needs
		// that lock) runs beside it; the answer is the same without the refresh.
		const script = `import subprocess,sys
root=sys.argv[1]
def git(*args): return subprocess.check_output(['git','--no-optional-locks','-C',root,*args],text=True).strip()
base=git('rev-parse','--verify','refs/ytimesy/base^{commit}')
if git('rev-parse','HEAD') != base or git('status','--porcelain','--untracked-files=all'): raise ValueError('Initial verification baseline is not pristine')
print(base)`;
		const observation = await input.machines.exec(
			input.vm,
			posixShellCommand(["python3", "-c", script, directory]),
			15000,
		);
		if (observation.exitCode)
			throw new Error(
				"A pristine server-owned verification baseline is required before writable execution. Existing edits were preserved.",
			);
		await pinVerificationBaseline(
			input.userId,
			input.sessionId,
			directory,
			observation.stdout.trim(),
		);
	}
}
