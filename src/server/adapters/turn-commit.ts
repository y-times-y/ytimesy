import type { PublicationAuthor } from "#/domain/publication";
import { MANAGED_GIT_BOT } from "./managed-git-identity";
import { commitAllArgv } from "./repository-setup";

const lockedTurnCommitScript = `import fcntl, os, pathlib, subprocess, sys, tempfile
directory, turn, command, expected_tree = sys.argv[1:]
def git(*args):
 return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
gitdir = pathlib.Path(git('rev-parse', '--absolute-git-dir'))
def require_verified_tree():
 if not expected_tree: return
 with tempfile.TemporaryDirectory(prefix='ytimesy-commit-tree-') as temporary:
  env={**os.environ,'GIT_INDEX_FILE':temporary+'/index'}
  subprocess.run(['git','-C',directory,'read-tree','HEAD'],env=env,check=True)
  subprocess.run(['git','-C',directory,'-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','add','-A','--','.'],env=env,check=True)
  tree=subprocess.check_output(['git','-C',directory,'write-tree'],env=env,text=True).strip()
  if tree != expected_tree: sys.exit('Checkout changed after authoritative verification; no successful completion was recorded.')
with (gitdir / 'ytimesy-auto-commit.lock').open('a') as lock:
 fcntl.flock(lock, fcntl.LOCK_EX)
 ref = 'refs/ytimesy/turn-commits/' + turn
 if subprocess.run(['git', '-C', directory, 'show-ref', '--verify', '--quiet', ref]).returncode == 0:
  sys.exit(0)
 if git('ls-files', '--unmerged') or any((gitdir / name).exists() for name in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']):
  sys.exit('Automatic commit paused: finish the Git conflict, merge, or rebase first.')
 if subprocess.run(['git', '-C', directory, 'show-ref', '--verify', '--quiet', 'refs/ytimesy/base']).returncode != 0:
  subprocess.run(['git', '-C', directory, 'update-ref', 'refs/ytimesy/base', 'HEAD'], check=True)
 require_verified_tree()
 subprocess.run(['bash', '-lc', command], check=True)
 if expected_tree and git('rev-parse','HEAD^{tree}') != expected_tree:
  sys.exit('Commit differs from the verified tree; local commit retained without publication.')
 require_verified_tree()
 subprocess.run(['git', '-C', directory, 'update-ref', ref, 'HEAD'], check=True)
`;

/** Serializes completion observers and remembers even turns with no dirty files. */
export function automaticTurnCommitArgv(
	directory: string,
	turn: string,
	message: string,
	expectedTree = "",
	author: PublicationAuthor = MANAGED_GIT_BOT,
	coAuthor: PublicationAuthor | null = MANAGED_GIT_BOT,
	humanCoAuthor: PublicationAuthor | null = null,
) {
	if (!/^[a-f0-9]{64}$/.test(turn))
		throw new Error("Invalid turn commit identity.");
	if (expectedTree && !/^[a-f0-9]{40,64}$/.test(expectedTree))
		throw new Error("Invalid verified tree identity.");
	const command = commitAllArgv(
		directory,
		message,
		author,
		coAuthor,
		humanCoAuthor,
	)[2];
	return [
		"python3",
		"-c",
		lockedTurnCommitScript,
		directory,
		turn,
		command,
		expectedTree,
	];
}
