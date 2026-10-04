/** Include staged, unstaged, and untracked files from the task checkout. */
export const agentTaskDiffScript = `git status --short
base=HEAD
if git show-ref --verify --quiet refs/ytimesy/base; then base=refs/ytimesy/base; fi
git diff "$base" -- .
git ls-files --others --exclude-standard -z |
  xargs -0 -r -I '{}' sh -c 'git diff --no-index -- /dev/null "$1" || [ "$?" -eq 1 ]' _ '{}'`;
