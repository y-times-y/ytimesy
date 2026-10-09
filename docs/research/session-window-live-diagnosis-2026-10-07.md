# Session-window live diagnosis — 2026-10-07

## Outcome

The private `session-coordinator-fixed` attempt did not produce an accepted,
graded result. Harbor reported one runtime exception and zero graded trials.
Its displayed mean of zero is not a measured correctness score. The agent
reached the unchanged 30-minute boundary; total operator runtime was 31m32s.
No native Codex inference ran.

The saved guard counters recorded 96 model requests and 2,928,554 observed
tokens. These are admission counters, not a complete billing statement or
cache-adjusted cost. This attempt provides no speed/token-efficiency win.

Evidence remains private in `.ytimesy/terminal-bench-pilot/`:

- `runs/session-window-debug__SGhb6FE/evidence.json`
- `runs/session-window-debug__SGhb6FE/failure.json`
- `runs/session-window-debug__SGhb6FE/cleanup.json`
- `private-jobs/session-coordinator-fixed/result.json`

## Observed defects and reproduced repairs

1. A child reported a blocking question while its durable API turn was still
   active. Blocked reporting incorrectly set its visible turn status to idle.
   The leader's `send_task_message` then attempted a second turn and hit
   `api_turn_one_active`. The unique constraint prevented duplicate execution.
   Guidance and peer delivery now consult owner-scoped queued/running turns;
   blocked reporting preserves running status while that execution exists.
   Existing peer queues and safe-point delivery are reused.
2. The builder exhausted its per-turn tool-step limit and required leader
   recovery. It later encountered a commit-stage failure. The historical log
   retained only `Error/unknown`, so its exact exception cannot be recovered
   from this artifact. Do not claim that the following reproduced problem is
   conclusively the historical exception.
3. The frozen Python task has no baseline project verification recipe or
   package test script. A real local checkout reproduces the completion gate's
   rejection of that configuration. Previously this became the generic Git
   handoff error, falsely suggesting authentication/hooks. A typed, fixed-text
   verification-policy failure now preserves the actionable category without
   exposing repository output, provider payloads or credentials. Evaluation
   admission now inspects the pristine pinned baseline with the existing
   completion-snapshot implementation and validates its check plan before
   registering or submitting inference.

The routing regressions failed before repair and passed afterward, including
actual SQL with PGlite. The completion diagnostic and admission regressions
also failed before repair. Targeted verification: 110 tests passed, one existing
test skipped, across ten files; TypeScript checking passed.

## Cleanup

The runner recorded complete cleanup with no failures. Live provider inventory
returned the pre-run four VMs and five snapshots, with no resources carrying
this attempt's ownership tag. No local Docker containers remained. Existing
user resources were preserved; no production deployment or migration ran.

## Remaining work before another meaningful attempt

- Resolve benchmark completion-policy setup explicitly, preserving protected
  grader independence and baseline integrity. Do not turn missing checks into
  an automatic pass or execute model-written policy as trusted verification.
- Verify the local-worker versus durable-step execution boundary. The current
  local fallback's tool-step failures and leader restarts differ from the
  durable orchestrator's continuation path; do not merely raise the step cap.
- Rerun only after those shared blockers are resolved, within the existing
  approval. Preserve the original three tasks and request/token/time limits.
- Judge correctness with the protected verifier, then report valid completion
  latency, usage and review evidence. Public native results are not a paired
  causal comparison under identical conditions.
