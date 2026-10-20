import { posix } from "node:path";
import { posixShellCommand } from "#/domain/posix-command";
import {
	pinVerificationBaseline,
	readVerificationBaseline,
} from "../adapters/turn-verification";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/**
 * Only a pristine initial checkout establishes policy; legacy dirty tasks fail
 * closed. A writer subagent's fork is never pristine (it starts from its
 * parent's working tree, committed as its fork base), so it inherits the
 * parent's pinned baseline for the same directory instead: the parent's is
 * server-owned already, and the fork is a copy of the parent's VM, so the
 * commit is there.
 */
export async function establishVerificationBaselines(
	input: AgentToolWorkspace & {
		userId: string;
		sessionId: string;
		additionalRepositoryNames?: readonly string[];
		/** A forked writer's parent session, whose baseline the fork inherits. */
		forkedFrom?: string;
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
			? await readVerificationBaseline(
					input.userId,
					input.forkedFrom,
					directory,
				)
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
		const script = `import subprocess,sys
root=sys.argv[1]
def git(*args): return subprocess.check_output(['git','-C',root,*args],text=True).strip()
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
