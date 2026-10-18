# Checker detection test

Development only. `scripts/checker-detect.ts` measures the independent checker on finished runs, without any builder run: given only the task instruction (and the spec files in the workspace) and the final workspace of a saved TB4 run, how often does the checker (a) name the actual cause of a run the hidden grader failed, and (b) wrongly flag a run the grader passed?

## Data

Our frozen TB4 run (v13-shell-039bee1, GPT-6.1 Sol): `../cloud/.ytimesy/harbor-jobs/backup-20261012/results.tgz.part-*` (`cat parts | tar xz` into `<data>/backup`). Trials are found and scored as the official TB4 scorer did (agent started, graded, model called); `invalid` and `warm-up` jobs are left out. The 2026-10-13 rerun only replaced GPU tasks and ctr-optimization, none of which is eligible or selected.

**Final workspace.** Harbor's verifier is separate (`environment_mode = "separate"`): the grader saw only the trial's artifacts (`artifacts/`, per `manifest.json`) on top of the task's pristine image. So image + artifacts is exactly what was graded. The restore (`scripts/checker-detect/restore.ts`) puts each artifact at its own path in its own service (a directory is replaced, git history kept; overlaid when the task lists excludes), applies a `git diff` artifact (`/tmp/agent.patch`) in the directory its collect step diffs, restarts a sidecar that received files, and checks each file by sha256. Not restored: builder scratch outside the artifacts, and sidecar state other than the restored files (caveat per sample).

## Sample (`--prepare`, `<data>/selection.json`)

Fixed before any checker output (salt `checker-detect-v1`, `scripts/checker-detect/select.ts`): eligible tasks need no GPU or task MCP server, at most 8 CPUs and 16 GB, build no image, and are not known broken (cad-model). A usable trial saved every artifact non-empty; a failing one also left grader output beyond the bare reward. Held-out tasks (heat-pump-warranty, legacy-utility-triage, mvcc-lsm-compaction: always passed by the public Codex job, not used in the failure analysis behind the brief) contribute every usable failing trial and are reported separately. Other failing samples: tasks ordered by sha256(salt:task), one trial each (lowest sha256(salt:trial)), up to 20 failing samples in all. Controls: 8 passing trials of other eligible tasks, same ordering.

## The checker

The brief is `independentReviewBrief` in `src/domain/checker-brief.ts` (meant to replace the product checker's brief once measured): the request verbatim and the deliverable (changed files, files delivered outside the working directory), never the builder's transcript or report, never `tests/` or `solution/`. It asks for (1) every requirement with evidence, (2) assumptions with alternatives tested, (3) plausibility, (4) exercising the deliverable as an outside grader would, and returns `{verdict, failures[], requirements[], assumptions[]}` (`parseReviewVerdict`).

Live, each sample runs as one development-harness turn for a throwaway eval user on the Codex subscription (GPT-6.1 Sol), in the task's environment on a development VM (the hard-set plumbing: `scripts/hard-set/environment.ts`, `scripts/hard-set/vm.ts`), with the workspace restored into the working directory. Differences from the product checker: it is a top-level builder turn (the builder's tool surface, write tools included; the brief forbids changes) instead of a read-only checker subagent, and it gets about 7 minutes (chunk limit of 10 minutes per invocation) instead of 12.

## Running

```
node --env-file=.env --import tsx scripts/checker-detect.ts --prepare --data <data>
node --env-file=.env --import tsx scripts/checker-detect.ts --list --data <data>
node --env-file=.env --import tsx scripts/checker-detect.ts --dry-run --local --run <name> --data <data> --samples <ids>   # local Docker, no VM, no model
node --env-file=.env --import tsx scripts/checker-detect.ts --dry-run --run <name> --data <data> --chunk 1                # dev VMs, no model
node --env-file=.env --import tsx scripts/checker-detect.ts --live --run <name> --data <data> --chunk 1                   # chunks 1-7, two side by side at most
node --env-file=.env --import tsx scripts/checker-detect.ts --grade --run <name> --data <data> [--live]
node --env-file=.env --import tsx scripts/checker-detect.ts --report --run <name> --data <data>
```

Records go to `.ytimesy/checker-detect/<run>/<sample>.<attempt>.json` (restore result and log, brief, report, verdict, tokens). The dry run does everything but the model call: environment, restore, the checks that `/tests` and `/solution` are absent and that no working-directory file is identical to a test or solution file (`FORBIDDEN` lines are files the task image itself ships, listed for review), and the brief.

## Grading and scoring

The checker never grades itself. `--grade` writes `grading-sheet.md` and one prompt per failing sample whose verdict is fail or unsure, under anonymous ids (`S-xxxxxxxx`): the instruction, the hidden grader's failure output (failed ctrf tests, detail files, test output tail) and the checker's findings. A person fills `grades.json`, or `--grade --live` asks a separate model session per sample (`codex exec`, read-only sandbox in an empty directory, structured answer). Labels: `named_cause` or `other` (with `otherReal`). `--report` prints the per-sample table and: detection rate (named the cause), wrong-cause rate (flagged something else), miss rate (verdict pass), each over failing samples with a run and a grade, held-out separately; false-alarm rate (verdict fail) on the controls.
