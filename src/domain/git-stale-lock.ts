import { posixShellQuoted as quote } from "./posix-command";

/** A lock this old is stale even while some Git command runs elsewhere. */
export const STALE_GIT_LOCK_MINUTES = 10;

/**
 * Shell that removes the repository's index.lock when no live Git command
 * holds it, so an interrupted command (a timed-out `git worktree add`, a
 * killed turn) does not block every later one with "index.lock: File exists".
 * The lock is the checkout's own (`--git-path`: a worktree has its own).
 *
 * Held means: a process has the file open (Git keeps its lock open until it
 * commits or rolls back; checked through /proc where it exists), or a `git`
 * process is running and the lock is younger than STALE_GIT_LOCK_MINUTES
 * (the check where /proc is missing, as on macOS, and for processes /proc
 * does not show this user). Never fails the command it precedes.
 */
export function clearStaleGitIndexLock(directory: string) {
	const dir = quote(directory);
	return `{ lock=$(git -C ${dir} rev-parse --path-format=absolute --git-path index.lock 2>/dev/null) && [ -f "$lock" ] && ! { [ -d /proc/self/fd ] && find /proc/[0-9]*/fd -maxdepth 1 -lname "$lock" 2>/dev/null | grep -q .; } && { ! ps -A -o comm= 2>/dev/null | grep -Eq '(^|/)git$' || [ -n "$(find "$lock" -prune -mmin +${STALE_GIT_LOCK_MINUTES} 2>/dev/null)" ]; } && rm -f -- "$lock" && echo "Removed a stale Git lock no running Git command held: $lock" >&2; true; }`;
}
