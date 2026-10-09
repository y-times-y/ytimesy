# Four-task builder pilot: prerequisite fixes and live blocker

The fresh approval allows Codex subscription inference and at most $5 of
disposable Freestyle resources. No inference or VM allocation started.

## Fixed and locally verified

- Reused the existing benchmark adapter in the isolated builder checkout,
  without importing the concurrent architecture changes in the main checkout.
- Install `ripgrep` through the guest's package manager and exercise both
  `rg --version` and a literal search before any model request.
- Preserve original verifier deadlines: 300 seconds for session/Next.js,
  600 for Bun, and 1,800 for WAL. The preceding adapter truncated these.
- Refuse to overwrite a prior output directory; pin public task/environment
  hashes and explicitly record the public Fast-mode uncertainty.
- Use the current builder loop's composition, deferred discovery, source
  freshness, scoped guidance, archive recovery and real repository tools.
  No leader, delegation, publication or production queue is exercised.

TypeScript and production build passed. Terminal adapter tests: 29 passed.
Initial adapter/composition checks: 36 passed. These are local checks, not
model performance evidence.

## Frozen pilot boundaries

Task order: session-window-debug, wal-recovery-ordering, nextjs-performance,
bun-sourcemap-leak. One attempt each; the first three are familiar tasks, not
holdouts. GPT-6.1 Sol, Max reasoning, our Fast mode explicitly off. Public Fast
mode is assumed off by user instruction, not independently verified.

This bounded pilot retains the current loop's 30-minute deadline, 128-request
guard and 4-million-observed-token guard. The public task allows eight hours;
therefore a guard hit is a censored/failed attempt, not a matched-condition
speed win. Hidden original tests are only available to the separate verifier.

## Live preflight result

The genuine operator's access-only Codex credential was copied into an owned
loopback database, tested and removed. The source database was not mutated.

Before compute allocation, the private archive upload failed. A read-only
storage diagnostic returned HTTP **402** and `exceed_egress_quota`: Supabase
restricted storage service until the project owner changes its plan or spend
cap. No alternate archive backend is configured in the current environment.

The runner did not silently bypass recoverable context or change billing.
Model requests: **0**. New VMs: **0**. Test database containers were removed.
Remote archive cleanup cannot be confirmed while storage rejects requests;
the failed upload was never reported as successful. Private failure artifacts
are retained outside Git.

Restore private storage service before resuming the same frozen pilot. The
$5 compute authorization was not consumed by this zero-compute preflight.
