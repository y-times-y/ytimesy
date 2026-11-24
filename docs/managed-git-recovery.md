# Publish committed work from a blocked managed branch

Use this only in a **ytimesy-managed workspace checkout** with the current managed Git hooks and a working, authorized `origin`. Do not run this in a user-owned checkout, install hooks by hand, bypass a guard, or add credentials to the VM. If the managed terminal cannot fetch or push to `origin`, stop and ask for help; the existing Publish button is not this recovery action.

## 1. Make a separate recovery branch

In the workspace terminal, check `git status --short --untracked-files=all`. If changes are listed, stop here. Review and commit any work you want included on the original branch using the normal managed commit flow, then recheck. This procedure copies only what is committed; ignored files remain in the original worktree and are not copied.

Choose a published base in the same repository (usually your PR's base, not the blocked local branch) and a **new** recovery branch name. Choose an unused sibling directory for the new worktree. For example, replacing `main`, `recovery/my-change`, and the directory as appropriate:

```sh
published_branch=main
recovery_branch=recovery/my-change
recovery_dir=../my-change-recovery
source_status=$(git status --porcelain --untracked-files=all) &&
  test -z "$source_status" &&
  source_tip=$(git rev-parse --verify HEAD) &&
  git fetch --no-tags --refmap= origin "refs/heads/$published_branch" &&
  published_tip=$(git rev-parse --verify 'FETCH_HEAD^{commit}') &&
  git merge-base "$published_tip" "$source_tip" >/dev/null &&
  git worktree add -b "$recovery_branch" "$recovery_dir" "$published_tip"
```

Stop if any command fails. The fetch does not update remote-tracking refs. `worktree add -b` refuses to reuse an existing branch. The original branch, index, and files stay in the original worktree.

## 2. Review and commit the recovered changes

```sh
git -C "$recovery_dir" merge --squash "$source_tip"
```

If there are conflicts, resolve and stage them **in the recovery worktree only**. Do not start the squash again on top of an unfinished one. Review `git -C "$recovery_dir" status` and `git -C "$recovery_dir" diff --cached`; if there is nothing to publish, stop. Then use `git -C "$recovery_dir" commit -m 'Recover changes for review'`. This creates a new commit on the published base; it does not make the blocked commits ancestors. The managed commit hook supplies the required trailer and checks both identities.

## 3. Publish explicitly, without replacing a branch

Check that the installed pre-push hook supports create-only recovery, then push only the new branch:

```sh
destination="refs/heads/$recovery_branch"
hooks=$(git -C "$recovery_dir" config --local --get core.hooksPath) &&
  test -x "$hooks/pre-push" &&
  grep -q YTIMESY_CREATE_RECOVERY_REF "$hooks/pre-push" &&
  YTIMESY_CREATE_RECOVERY_REF="$destination" git -C "$recovery_dir" \
    -c push.followTags=false push origin "HEAD:$destination"
```

The hook refuses to update any existing destination and still validates the unpublished commits. If the push was interrupted, compare `git -C "$recovery_dir" rev-parse HEAD` with the exact destination from `git -C "$recovery_dir" ls-remote --refs origin "$destination"`. An identical SHA means it already published; an absent ref permits retrying the same push; a different SHA means stop and choose a new name. Never force-push. Open a PR from the recovery branch if desired. Keep the original branch and worktree until you've confirmed the recovered changes are complete.
