import { randomUUID } from "node:crypto";
import { z } from "zod";
import { posixShellQuoted } from "#/domain/posix-command";
import type { ConversationPoint } from "../adapters/conversation-recovery";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const hash = z.string().regex(/^[a-f0-9]{40,64}$/);
const snapshot = z.object({
	cwd: z.string(),
	tree: hash,
	indexTree: hash,
	head: hash,
	ref: z.string().regex(/^refs\/ytimesy\/recovery\/[a-zA-Z0-9-]+$/),
});
export const CODE_CHECKPOINT_SCRIPT = `import fcntl,hashlib,json,os,pathlib,subprocess,sys,tempfile
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
 env.update({'GIT_AUTHOR_NAME':'ytimesy recovery','GIT_AUTHOR_EMAIL':'recovery@localhost','GIT_COMMITTER_NAME':'ytimesy recovery','GIT_COMMITTER_EMAIL':'recovery@localhost'})
 commit=git('commit-tree',tree,'-p',head,'-m','Recoverable working tree',env=env)
 git('update-ref',ref,commit)
 staged=git('commit-tree',index,'-p',head,'-m','Recoverable index',env=env)
 git('update-ref',ref+'-index',staged)
print(json.dumps({'cwd':requestedRoot,'tree':tree,'indexTree':index,'head':head,'ref':ref}))`;

export async function captureConversationCode(
	workspace: AgentToolWorkspace,
): Promise<NonNullable<ConversationPoint["code"]>> {
	const ref = `refs/ytimesy/recovery/${randomUUID()}`;
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${posixShellQuoted(CODE_CHECKPOINT_SCRIPT)} ${posixShellQuoted(workspace.cwd)} ${posixShellQuoted(ref)}`,
		25_000,
	);
	if (result.exitCode)
		throw new Error(
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
		throw new Error(
			"Code rewind failed; the pre-restore backup remains available.",
		);
}
