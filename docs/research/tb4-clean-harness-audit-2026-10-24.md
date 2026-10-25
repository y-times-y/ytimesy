# TB4 clean-harness audit (2026-10-24)

Goal: the base harness that produces a reported Terminal-Bench 4 score contains
nothing shaped by reading why TB4's graders failed our runs. Bug fixes and
general engineering stay; rules derived from TB4 grader output go.

Rule used: a change is removed when its motivation came from TB4 hidden-test or
grader output on specific tasks. A change stays when it fixes a harness defect
(crash, hang, lost output, lost background job), improves cost or efficiency
from trajectory behaviour alone, or states a true operating condition.

Base TB4 path: `lead=off,review=off,rigor=off,codeMode=primary`, unattended
(Harbor bridge v2).

## Removed

| Item | Where | Origin |
|---|---|---|
| "Request's stated symptoms, definitions and inputs outrank design notes, docstrings, existing behavior and defaults" | `UNATTENDED_RUN_INSTRUCTIONS` (rigor.ts) | 669b10a, from grader-failure analysis (atrx, session-window) |
| "A term with an established meaning in a widely used library or field keeps that meaning" | same | 669b10a, batched-eval-parity grader failure |
| "Derived or co-adjusted values: work them out under each reading and keep the one that reproduces them" | same | 669b10a, freecad-spring-clip grader failure |
| "Speed or ratio target: measure it the way it will be judged ..." | same | 669b10a, vf2 grader failure |
| "Before an irreversible submission, finish checks and re-check the payload against the rules" | same | 8ccc3f3, heat-pump-warranty grader failure |
| Missing-module hint pointing at `--keep-env` for PYTHONPATH | `deliverable-check.ts` | 669b10a, freecad grader failure (reverted to the earlier message) |

## Kept, with reason

| Item | Reason |
|---|---|
| "Unattended run: nobody will answer a question ...; ship the best-supported deliverable and state the assumption" | True operating condition of any unattended run |
| Lean tools, code mode primary | General design; code mode measured on cost |
| Bounded commands, output tail kept with a cut note, background-command notices and completion gate | Harness defects (hangs, lost background results) |
| Degenerate-output cut and resample; output-cap resample; transient-failure retry | Harness defects |
| `ytimesy-check` clean-copy run (Oct 16) and its flag list | General grader-style run from the Oct 14 failure-category audit (category level, not task answers); flags listed because the model kept running `--help` |
| "Targeted edits over heredoc rewrites"; brief unattended final answer | Cost, from trajectory behaviour |
| 48k command length | Commands were rejected by a length limit (harness defect) |

## Not on the base path (left in code, off for TB4)

The review checker's brief (symptom acceptance tests, convention over literal,
re-derive before rationale), rigor, Fusion lead and checker modes. They contain
TB4-derived rules but are disabled in the measured configuration.

## Residual exposure

The Oct 12 full TB4 run's 99 failures were classified by type on Oct 14; the
general mechanisms above (clean-copy check, background gate) respond to those
categories. Task-level study since then is recorded in
`benchmarks/evaluation/terminal-bench-splits.json` (`moved`).
