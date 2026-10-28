/**
 * How a builder integrates a writer that worked on its own copy of the
 * checkout and returned a patch and git ref (a product writer on a VM fork,
 * or the Harbor bridge's helpers=write-tree writer on a git worktree): one
 * sentence, so the bridge measures the product's own integration step.
 * The wording is the product orchestration block's (the delegation policy
 * change, 2026-10-28); src/domain/subagent-instructions.ts should use this
 * constant once that change is on main.
 */
export const WRITER_PATCH_INTEGRATION =
	"Integrate a writer's part by reviewing its patch (`git diff <base> <ref>`), applying it with `git apply -3` and rerunning its checks yourself.";
