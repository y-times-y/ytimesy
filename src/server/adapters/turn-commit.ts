import { publicationCommitAuthor } from "#/domain/publication";
import { commitAllArgv } from "./repository-setup";

const lockedTurnCommitScript = `import fcntl, pathlib, subprocess, sys
directory, turn, command = sys.argv[1:]
def git(*args):
 return subprocess.check_output(['git', '-C', directory, *args], text=True).strip()
gitdir = pathlib.Path(git('rev-parse', '--absolute-git-dir'))
with (gitdir / 'ytimesy-auto-commit.lock').open('a') as lock:
 fcntl.flock(lock, fcntl.LOCK_EX)
 ref = 'refs/ytimesy/turn-commits/' + turn
 if subprocess.run(['git', '-C', directory, 'show-ref', '--verify', '--quiet', ref]).returncode == 0:
  sys.exit(0)
 if git('ls-files', '--unmerged') or any((gitdir / name).exists() for name in ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']):
  sys.exit('Automatic commit paused: finish the Git conflict, merge, or rebase first.')
 if subprocess.run(['git', '-C', directory, 'show-ref', '--verify', '--quiet', 'refs/ytimesy/base']).returncode != 0:
  subprocess.run(['git', '-C', directory, 'update-ref', 'refs/ytimesy/base', 'HEAD'], check=True)
 subprocess.run(['bash', '-lc', command], check=True)
 subprocess.run(['git', '-C', directory, 'update-ref', ref, 'HEAD'], check=True)
`;

/** Serializes completion observers and remembers even turns with no dirty files. */
export function automaticTurnCommitArgv(
	directory: string,
	turn: string,
	message: string,
) {
	if (!/^[a-f0-9]{64}$/.test(turn))
		throw new Error("Invalid turn commit identity.");
	const command = commitAllArgv(
		directory,
		message,
		publicationCommitAuthor({}),
	)[2];
	return ["python3", "-c", lockedTurnCommitScript, directory, turn, command];
}
