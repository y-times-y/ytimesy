# Session-window diagnostic with Codex subscription

## Outcome

The full production leader/builder path did not deliver a reviewed artifact. This is an invalid lifecycle evaluation, not a hidden-grader failure and not evidence of a win over native Codex. No native inference was launched.

Private evidence: `.ytimesy/terminal-bench-pilot/runs/session-window-matched-max-20261008/` (`evidence-recovered.json`, `failure.json`, `cleanup.json`, and frozen `protocol.json`).

The isolated ledger recorded **68 requests and 1,986,055 observed tokens**. Recorded turns span 17:30:58–17:59:53 UTC, approximately **29 minutes**. Those are cumulative observed ledger tokens, not audited billable uncached tokens. No official hidden grade ran, because there was no accepted artifact.

## Matched and unmatched conditions

- Task: original `session-window-debug`; canonical Harbor content digest exactly matches the public native task: `sha256:f7e05e0d4c0e90d7050445fd158db514158272c50aafa1b2446ef3f68bd01182`.
- Model: GPT-6.1 Sol; reasoning maximum; our fast mode disabled.
- Agent and verifier images pinned separately; verifier contents were not provided to the model.
- Our operator-owned admission recipe checks Python syntax only. It is not a correctness grader.
- Our billing uses the approved Codex subscription. Public native metadata uses direct API-key credentials.
- Our production pipeline includes leader, builder, completion verification, and review. Native public trials use Codex 0.159.0 directly.
- Our run has a 30-minute operational bound. The task states eight hours; public effective enforcement and fast/service tier are not independently established. Effective native hardware is not independently established either.

## Failure and trace observations

The builder finished a patch and reported passing its own regression tests. Completion failed twice at the worker's `commit` stage; the leader resumed it for investigation and compatibility repair. Self-authored tests are not an official benchmark result.

The disposable database held one server-owned baseline at `verification-baseline:/root/session-window-debug`. `commitCompletedSessionTurn` instead calls `repositoryDirectory`, which resolves this repository to `/home/ubuntu/session-window-debug`. `readVerificationBaseline` requires an exact directory key, so completion cannot find that baseline. There were no `verification-run:` command receipts. This mismatch is sufficient to reject completion before checks; the generic error card mislabeled it as automatic Git handoff failure.

Additional visible overhead included repeated repository-guidance/discovery calls, repeated retained-output reads, leader progress turns, and recovery after the completion failure. These observations do not establish a causal speedup for any proposed fix.

The operator stopped the invalid run. SIGINT exited before the evaluator's ordinary finalization, so evidence was recovered from the disposable database and owned resources were cleaned up explicitly. The interruption/cleanup path also needs hardening before another paid evaluation.

## Public comparator

The [public native job](https://hub.harborframework.com/jobs/299f37fe-9a7f-51f4-9619-af26e8312fd7) has five scored trials of this task: 4/5 succeed, averaging 12.2 recorded generations, approximately 541 seconds, and 374,445 input-plus-output tokens. See [request-count evidence](native-codex-request-count-2026-10-08.md) and [task-result evidence](native-codex-terminal-bench-task-results-2026-10-07.md).

These are public repeated trials, not a new paired experiment. Our failed single full-pipeline run cannot produce a quality comparison. It does show substantially greater elapsed time and observed token use under these disclosed conditions.

## Verification of the evaluator admission change

35 targeted tests passed across the Terminal-Bench machine bridge and production-evaluation suites. Typecheck and diff whitespace checks passed. These verify evaluator setup behavior, not benchmark correctness or production readiness. No shared database migration, production deployment, commit, or push was performed for this run.
