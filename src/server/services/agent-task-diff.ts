/** Include staged, unstaged, and untracked files from the task checkout. */
export const agentTaskDiffScript = `git status --short
git diff HEAD -- .
git ls-files --others --exclude-standard -z |
  xargs -0 -r -I '{}' sh -c 'git diff --no-index -- /dev/null "$1" || [ "$?" -eq 1 ]' _ '{}'`;
