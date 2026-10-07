import { createHash } from "node:crypto";
import {
	type CompletedVerification,
	completedVerification,
	completionSnapshot,
} from "#/domain/completion-verification";
import { WorkspaceId } from "#/domain/ids";
import { taskVerificationPlan } from "#/domain/task-integration-checks";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
	renewAgentTaskCommandClaim,
} from "../adapters/agent-task-command-receipts";
import {
	findCompletedVerification,
	readVerificationBaseline,
	recordCompletedVerification,
} from "../adapters/turn-verification";
import { agentOutputArtifacts } from "./agent-output-artifacts";
import { scopedShellCommand, stopApiTurnCommands } from "./api-command-scope";
import type { TurnGitRuntime } from "./turn-publication";
import type { WorkspaceMachines } from "./workspace-machines";

export const COMPLETION_SNAPSHOT_SOURCE = `import hashlib,json,os,subprocess,sys,tempfile
root=sys.argv[1]
def git(*args,env=None):
    return subprocess.check_output(['git','-C',root,*args],env=env)
base=sys.argv[2]
if git('rev-parse','--verify','refs/ytimesy/base^{commit}').decode().strip()!=base: raise ValueError('Saved baseline differs from server-owned baseline')
head=git('rev-parse','HEAD').decode().strip()
git('merge-base','--is-ancestor',base,head)
if git('ls-files','--unmerged').strip(): raise ValueError('Unresolved Git conflicts')
with tempfile.TemporaryDirectory(prefix='ytimesy-verify-') as temporary:
    env={**os.environ,'GIT_INDEX_FILE':temporary+'/index'}
    git('read-tree','HEAD',env=env)
    git('-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','add','-A','--','.',env=env)
    tree=git('write-tree',env=env).decode().strip()
    patch=git('diff','--cached','--binary','--full-index','--no-ext-diff',base,'--','.',env=env)
    if len(patch)>8*1024*1024: raise ValueError('Verification patch exceeds limit')
def contents(path,revision=base):
    exists=subprocess.run(['git','-C',root,'cat-file','-e',revision+':'+path],capture_output=True)
    return git('show',revision+':'+path).decode() if exists.returncode==0 else None
def scripts(revision):
    manifest=contents('package.json',revision)
    return json.loads(manifest).get('scripts',{}) if manifest else {}
policy_changed=contents('.ytimesy/environment.json')!=contents('.ytimesy/environment.json',tree) or scripts(base)!=scripts(tree)
print(json.dumps({'base':base,'tree':tree,'patchSha256':hashlib.sha256(patch).hexdigest(),'changed':bool(patch),'policyChanged':policy_changed,'recipe':contents('.ytimesy/environment.json'),'manifest':contents('package.json'),'files':git('ls-tree','--name-only',base).decode().splitlines()}))`;

/** Every check is chosen by baseline policy and bound to the whole Git tree, not eight model-declared files. */
export async function verifyCompletedRepository(input: {
	runtime: TurnGitRuntime;
	providerRef: string;
	directory: string;
	userId: string;
	sessionId: string;
	turn: string;
	signal?: AbortSignal;
	/** Server-owned integrations can retain their existing progress UI and command capture. Never expose this through a model tool. */
	executeCheck?: (
		command: string,
	) => Promise<CompletedVerification["checks"][number]>;
}) {
	const signal = input.signal ?? AbortSignal.timeout(15 * 60_000);
	signal.throwIfAborted();
	const trustedBase = await readVerificationBaseline(
		input.userId,
		input.sessionId,
		input.directory,
	);
	if (!trustedBase)
		throw new Error(
			"The task has no server-owned verification baseline. Establish an approved pristine checkout before completion.",
		);
	const snapshot = async () => {
		signal.throwIfAborted();
		const observed = await input.runtime.exec(
			input.providerRef,
			[
				"python3",
				"-c",
				COMPLETION_SNAPSHOT_SOURCE,
				input.directory,
				trustedBase,
			],
			{},
			30_000,
		);
		if (observed.exitCode)
			throw new Error(
				"Completion verification cannot establish the saved baseline and complete checkout.",
			);
		return completionSnapshot.parse(JSON.parse(observed.stdout));
	};
	const before = await snapshot();
	if (!before.changed)
		return { status: "unchanged" as const, tree: before.tree };
	if (before.policyChanged)
		throw new Error(
			"Verification command policy changed. A separately approved baseline is required; changed check scripts were not executed.",
		);
	const groups = [
		["git diff --check && git diff --cached --check"],
		...taskVerificationPlan(before),
	];
	const existing = await findCompletedVerification(
		input.userId,
		input.sessionId,
		input.directory,
		before,
	);
	if (
		existing &&
		groups
			.flat()
			.every((command) =>
				existing.checks.some((check) => check.command === command),
			)
	) {
		const current = await snapshot();
		if (
			current.tree !== before.tree ||
			current.base !== before.base ||
			current.patchSha256 !== before.patchSha256
		)
			throw new Error(
				"Checkout changed while observing verification evidence.",
			);
		return {
			status: "verified" as const,
			tree: before.tree,
			receipt: existing,
		};
	}
	const machines = {
		exec: (vm: string, command: string, timeout: number) =>
			input.runtime.exec(vm, ["bash", "-lc", command], {}, timeout),
	} as unknown as WorkspaceMachines;
	const requestId = `verification-run:${input.turn}:${input.directory}:${before.tree}`;
	const claim = await claimAgentTaskCommand(input.sessionId, requestId);
	if (claim.kind !== "claimed")
		throw new Error(
			"This verification attempt already ran or has an uncertain outcome. Inspect retained evidence; it was not replayed.",
		);
	let journalLost = false;
	const heartbeat = setInterval(() => {
		void renewAgentTaskCommandClaim(input.sessionId, requestId).catch(() => {
			journalLost = true;
		});
	}, 10_000);
	heartbeat.unref();
	const workspace = {
		machines,
		vm: WorkspaceId(input.providerRef),
		cwd: input.directory,
	};
	const artifacts = agentOutputArtifacts({
		...workspace,
		sessionId: input.sessionId,
		signal,
	});
	const turnId = `verify-${createHash("sha256")
		.update(JSON.stringify([input.turn, input.directory]))
		.digest("hex")}`;
	let stopping: Promise<unknown> | undefined;
	const stop = () => {
		stopping ??= stopApiTurnCommands(workspace, turnId);
		void stopping.catch(() => {});
	};
	signal.addEventListener("abort", stop, { once: true });
	const checks: CompletedVerification["checks"] = [];
	try {
		for (const group of groups) {
			for (let offset = 0; offset < group.length; offset += 2) {
				const settled = await Promise.allSettled(
					group.slice(offset, offset + 2).map(async (command) => {
						signal.throwIfAborted();
						if (input.executeCheck) {
							const check = completedVerification.shape.checks.element.parse(
								await input.executeCheck(command),
							);
							if (check.command !== command)
								throw new Error(
									"Verification executor returned a different command.",
								);
							return check;
						}
						const output = await artifacts.capture(
							scopedShellCommand({
								turnId,
								cwd: input.directory,
								command,
								seconds: 120,
							}),
							125,
						);
						if (output.exitCode !== 0 || output.stopped !== null)
							throw new Error(
								`Required completion check failed: ${command}. Retained output reference: ${output.reference}; exit ${output.exitCode}; stopped ${output.stopped ?? "no"}.`,
							);
						return {
							command,
							reference: output.reference,
							exitCode: 0 as const,
							stopped: null,
						};
					}),
				);
				for (const result of settled)
					if (result.status === "fulfilled") checks.push(result.value);
				const failed = settled.find((result) => result.status === "rejected");
				if (failed?.status === "rejected") throw failed.reason;
			}
		}
		signal.throwIfAborted();
		if (journalLost)
			throw new Error(
				"Verification journal ownership became uncertain; no successful completion was recorded.",
			);
		const after = await snapshot();
		if (
			after.tree !== before.tree ||
			after.base !== before.base ||
			after.patchSha256 !== before.patchSha256
		)
			throw new Error(
				"Checkout changed during required checks; no current verification receipt was accepted.",
			);
		const receipt: CompletedVerification = {
			type: "completion-verification",
			directory: input.directory,
			turn: input.turn,
			base: before.base,
			tree: before.tree,
			patchSha256: before.patchSha256,
			checks,
		};
		await recordCompletedVerification(input.userId, input.sessionId, receipt);
		await completeAgentTaskCommand(input.sessionId, {
			id: requestId,
			ok: true,
			result: receipt,
		});
		return { status: "verified" as const, tree: before.tree, receipt };
	} catch (error) {
		await completeAgentTaskCommand(input.sessionId, {
			id: requestId,
			ok: false,
			error:
				"Required verification failed or became uncertain. Inspect retained command output and preserved checkout before a new turn.",
		});
		throw error;
	} finally {
		clearInterval(heartbeat);
		signal.removeEventListener("abort", stop);
		if (signal.aborted) {
			stop();
			await stopping;
		}
	}
}
