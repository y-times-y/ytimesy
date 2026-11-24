import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RecoveryRefused } from "#/domain/conversation-recovery-failure";
import { posixShellQuoted } from "#/domain/posix-command";
import type { ConversationPoint } from "../adapters/conversation-recovery";
import {
	MANAGED_GIT_BOT,
	MANAGED_GIT_TRAILER,
} from "../adapters/managed-git-identity";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const hash = z.string().regex(/^[a-f0-9]{40,64}$/);
const snapshot = z.object({
	cwd: z.string(),
	tree: hash,
	indexTree: hash,
	head: hash,
	ref: z
		.string()
		.regex(/^refs\/ytimesy\/(recovery|attempts|review)\/[a-zA-Z0-9-]+$/),
});
const CODE_CHECKPOINT_SCRIPT = `import fcntl,hashlib,json,os,pathlib,subprocess,sys,tempfile
root,ref=sys.argv[1:3]
requestedRoot=root
root=str(pathlib.Path(root).resolve(strict=True))
lock=open('/tmp/ytimesy-edit-lock-'+hashlib.sha256(root.encode()).hexdigest(),'a');fcntl.flock(lock,fcntl.LOCK_EX)
def git(*args,env=None):
 return subprocess.check_output(['git','-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],env=env).decode().strip()
if git('ls-files','--unmerged'): raise ValueError('Resolve Git conflicts before creating a recovery point')
head=git('rev-parse','HEAD')
index=git('write-tree')
with tempfile.TemporaryDirectory(prefix='ytimesy-recovery-') as tmp:
 env={**os.environ,'GIT_INDEX_FILE':tmp+'/index'}
 git('read-tree','HEAD',env=env)
 git('add','-A','--','.',env=env)
 tree=git('write-tree',env=env)
 env.update(${JSON.stringify({ GIT_AUTHOR_NAME: MANAGED_GIT_BOT.name, GIT_AUTHOR_EMAIL: MANAGED_GIT_BOT.email, GIT_COMMITTER_NAME: MANAGED_GIT_BOT.name, GIT_COMMITTER_EMAIL: MANAGED_GIT_BOT.email })})
 commit=git('commit-tree',tree,'-p',head,'-m','Recoverable working tree','-m',${JSON.stringify(MANAGED_GIT_TRAILER)},env=env)
 git('update-ref',ref,commit)
 staged=git('commit-tree',index,'-p',head,'-m','Recoverable index','-m',${JSON.stringify(MANAGED_GIT_TRAILER)},env=env)
 git('update-ref',ref+'-index',staged)
print(json.dumps({'cwd':requestedRoot,'tree':tree,'indexTree':index,'head':head,'ref':ref}))`;

/** `ref` defaults to a new recovery ref; the attempt and review loops name their own (refs/ytimesy/attempts/..., refs/ytimesy/review/...). */
export async function captureConversationCode(
	workspace: AgentToolWorkspace,
	ref = `refs/ytimesy/recovery/${randomUUID()}`,
): Promise<NonNullable<ConversationPoint["code"]>> {
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${posixShellQuoted(CODE_CHECKPOINT_SCRIPT)} ${posixShellQuoted(workspace.cwd)} ${posixShellQuoted(ref)}`,
		// A large checkout on a machine just woken from sleep reads slowly.
		90_000,
	);
	if (result.exitCode)
		throw new RecoveryRefused(
			"Could not create the code recovery point; no restore was attempted.",
		);
	return snapshot.parse(JSON.parse(result.stdout));
}

/** Git handles file modes/binary contents. Ignored files, branch history and external effects stay outside code rewind. */
export async function restoreConversationCode(
	workspace: AgentToolWorkspace,
	point: NonNullable<ConversationPoint["code"]>,
	expectedCurrent?: NonNullable<ConversationPoint["code"]>,
) {
	const saved = snapshot.parse(point);
	if (saved.cwd !== workspace.cwd)
		throw new Error("Recovery point belongs to a different checkout.");
	const expected = expectedCurrent ? snapshot.parse(expectedCurrent) : null;
	const script = `import fcntl,hashlib,os,pathlib,subprocess,sys,tempfile
root,ref,tree,index,expected,expectedIndex,expectedHead=sys.argv[1:8]
root=str(pathlib.Path(root).resolve(strict=True))
lock=open('/tmp/ytimesy-edit-lock-'+hashlib.sha256(root.encode()).hexdigest(),'a');fcntl.flock(lock,fcntl.LOCK_EX)
def git(*args,env=None):return subprocess.check_output(['git','-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],env=env)
if git('rev-parse',ref+'^{tree}').decode().strip()!=tree or git('rev-parse',ref+'-index^{tree}').decode().strip()!=index:raise ValueError('Recovery refs are missing or changed')
if git('ls-files','--unmerged').strip():raise ValueError('Resolve Git conflicts before rewinding code')
if expected:
 if git('rev-parse','HEAD').decode().strip()!=expectedHead or git('write-tree').decode().strip()!=expectedIndex:raise ValueError('Checkout changed after recovery backup; retry')
 with tempfile.TemporaryDirectory(prefix='ytimesy-recovery-check-') as tmp:
  env={**os.environ,'GIT_INDEX_FILE':tmp+'/index'}
  git('read-tree','HEAD',env=env);git('add','-A','--','.',env=env)
  if git('write-tree',env=env).decode().strip()!=expected:raise ValueError('Files changed after recovery backup; retry')
untracked=git('ls-files','--others','--exclude-standard','-z').decode().split('\\0')
# All current nonignored files were backed up by the caller. Preserve ignored dependencies and credentials.
for name in untracked:
 if not name:continue
 path=pathlib.Path(root)/name
 if path.is_file() or path.is_symlink():path.unlink()
git('restore','--source='+tree,'--staged','--worktree','--','.')
git('read-tree',index)
print('restored')`;
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${posixShellQuoted(script)} ${posixShellQuoted(workspace.cwd)} ${posixShellQuoted(saved.ref)} ${posixShellQuoted(saved.tree)} ${posixShellQuoted(saved.indexTree)} ${posixShellQuoted(expected?.tree ?? "")} ${posixShellQuoted(expected?.indexTree ?? "")} ${posixShellQuoted(expected?.head ?? "")}`,
		25_000,
	);
	if (result.exitCode || !result.stdout.includes("restored"))
		throw new RecoveryRefused(
			"Code rewind failed; the pre-restore backup remains available.",
		);
}

/** The fork's error when the source VM no longer holds the message's checkpoint refs. */
export const FORK_CHECKPOINT_GONE =
	"This message's code checkpoint is gone, so the chat was not forked.";

const CHECKPOINT_PRESENT_CHECK = `def rev(spec):
 try:return git('rev-parse','-q','--verify',spec).decode().strip()
 except subprocess.CalledProcessError:return ''
if rev(ref+'^{tree}')!=tree or rev(ref+'-index^{tree}')!=index or rev(ref+'^1')!=head:
 print('checkpoint-missing');sys.exit(3)`;

/**
 * Checks, without changing anything, that the checkout still holds the
 * point's refs, so a fork fails before a VM is copied for it.
 */
export async function assertConversationCodePresent(
	workspace: AgentToolWorkspace,
	point: NonNullable<ConversationPoint["code"]>,
) {
	const saved = snapshot.parse(point);
	if (saved.cwd !== workspace.cwd)
		throw new Error("Recovery point belongs to a different checkout.");
	const script = `import pathlib,subprocess,sys
root,ref,tree,index,head=sys.argv[1:6]
root=str(pathlib.Path(root).resolve(strict=True))
def git(*args):return subprocess.check_output(['git','-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],stderr=subprocess.DEVNULL)
${CHECKPOINT_PRESENT_CHECK}
print('present')`;
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${posixShellQuoted(script)} ${[saved.cwd, saved.ref, saved.tree, saved.indexTree, saved.head].map(posixShellQuoted).join(" ")}`,
		25_000,
	);
	if (result.stdout.includes("checkpoint-missing"))
		throw new RecoveryRefused(FORK_CHECKPOINT_GONE);
	if (result.exitCode || !result.stdout.includes("present"))
		throw new RecoveryRefused(
			"The chat's code checkpoint could not be read; retry.",
		);
}

/**
 * Runs in a copy of the source VM: puts the checkout on its own new branch at
 * the commit the point was taken on, with the point's files and index, as
 * Restore code would leave them. Ignored files (dependencies, .env) stay.
 */
export async function startCheckoutFromConversationCode(
	workspace: AgentToolWorkspace,
	point: NonNullable<ConversationPoint["code"]>,
	branch: string,
) {
	const saved = snapshot.parse(point);
	const script = `import fcntl,hashlib,pathlib,subprocess,sys
root,ref,tree,index,head,branch=sys.argv[1:7]
root=str(pathlib.Path(root).resolve(strict=True))
lock=open('/tmp/ytimesy-edit-lock-'+hashlib.sha256(root.encode()).hexdigest(),'a');fcntl.flock(lock,fcntl.LOCK_EX)
def git(*args):return subprocess.check_output(['git','-C',root,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],stderr=subprocess.DEVNULL)
${CHECKPOINT_PRESENT_CHECK}
git('check-ref-format','--branch',branch)
git('checkout','-q','-f','-B',branch,head)
for name in git('ls-files','--others','--exclude-standard','-z').decode().split('\\0'):
 if not name:continue
 path=pathlib.Path(root)/name
 if path.is_file() or path.is_symlink():path.unlink()
git('restore','--source='+tree,'--staged','--worktree','--','.')
git('read-tree',index)
print('forked')`;
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${posixShellQuoted(script)} ${[workspace.cwd, saved.ref, saved.tree, saved.indexTree, saved.head, branch].map(posixShellQuoted).join(" ")}`,
		60_000,
	);
	if (result.stdout.includes("checkpoint-missing"))
		throw new RecoveryRefused(FORK_CHECKPOINT_GONE);
	if (result.exitCode || !result.stdout.includes("forked"))
		throw new Error(
			"The fork could not start from this message's code; the source chat is unchanged.",
		);
}
