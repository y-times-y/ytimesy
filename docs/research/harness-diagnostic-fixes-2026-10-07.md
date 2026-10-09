# Terminal-Bench diagnostic fixes

These changes address reproduced harness defects, not benchmark superiority.
No new inference, machines, deployment, or changes to evaluation caps were used.

## Reproduced and fixed

- Durable model-step reconstruction retained root guidance but forgot nested scopes. Re-reading the same scope produced two extra guidance events. Loaded scopes now reconstruct from surviving successful guidance receipts. The regression produces zero additional events; failed or invalid receipts do not suppress reads, and changed nested instruction bodies still reload.
- Initial concurrent reads used fail-fast `Promise.all`. A preparation failure could leave a started tool card without a terminal result. Reads now settle before propagating failure, emit sanitized failed receipts, and preserve cancellation. Preparation failure remains distinct from provider rejection through the streaming model loop. No inference starts on failed preparation.
- Healthy builders triggered leader check-ins at five and ten minutes despite recent progress. These wakeups are now suppressed. Quiet builders retain bounded check-ins; a progressing long-running builder still gets a fifteen-minute check-in. Durable acknowledgment prevents repeated delivery across restarts.

## Verification

Three regression tests failed before their fixes and passed afterward.
The nine-file affected suite passes 95 tests, including local working-tree guidance checks, runtime failure handling, supervision delivery, and task evidence/guidance tests.
Typecheck (including workflows), production build, focused Biome checks, and diff whitespace checks pass.

## Limits

The private diagnostic attempts did not produce accepted benchmark outcomes. These local tests do not establish lower end-to-end latency, token consumption, or better code quality than native Codex.
The original WAL VM-preparation cause is not recovered from the old generic error. Improved classification and settled receipts make a future recurrence observable; they do not prove that provisioning itself is repaired.
Builder completion, review, and integration within the frozen budget remain to be demonstrated in a live run. No benchmark time, token, or request limit was increased to mask a failure.
