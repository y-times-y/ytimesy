# Infrastructure allowances

## Wallet observation — 2026-10-04

The user supplied a month-to-date Freestyle Wallet reading, not a finalized usage
statement. It showed a $0 bill, $24.83 of the $50 included allowance consumed, and
$10,000 promotional credits remaining (expiry September 15, 2027). Hobby plan fees
are sponsored until March 15, 2027; the displayed subsequent fee is $50/month.

The reading showed 290 vCPU-hours against 200 free, 580 GiB-hours of memory against
400 free, and 58,710 GiB-hours of VM/snapshot storage against 60,000 free. Storage
had only 1,290 free GiB-hours remaining and accrues even for stopped machines.
Transfer was 27.1 GB against 500 GB free, with $0 estimated transfer charges and
$0.02/GB displayed beyond the allowance. Internal VPC traffic is excluded.

These figures describe allowance consumption, not separate gross billed resource
categories. They were not imported into the immutable finalized-statement ledger.
They do not make compute admission an invoice-wide cap or make storage free
indefinitely. The pasted included-usage reset label was inconsistent with the
current date, so no billing period is inferred from it.

## Implementation status

Development rollout on 2026-10-03 applies both infrastructure migrations and
enables owner-scoped compute admission in the web app and existing job worker.
Settings → Account displays used, reserved and remaining cloud minutes. Genuine
signed-in, explicitly allowlisted administrators can grant themselves or another
user current-month credit, or change a persistent monthly allowance. Local QA
preview identities cannot grant credit. Adjustments record actor and reason;
unknown-outcome retries reuse their request UUID.

Defaults: 30 standard cloud minutes per user per UTC month, $500 monthly compute
admission ceiling and $7,000 lifetime compute admission ceiling. A standard minute
means 2 vCPU and 4 GiB RAM; larger machines consume allowance proportionally.
The lifetime ceiling leaves $3,000 of the reported $10,000 credits outside this
ledger. These are COMPUTE admission limits, not a complete provider invoice cap.
Worker overhead, disks, snapshots and transfer are not metered by this ledger.
Legacy user VMs are enrolled on normal budgeted resume, not retroactively changed.

The separate API token safety budget remains unchanged. Model-provider billing is
not infrastructure billing, and a user's model subscription does not supply VM
credits.

## Accounting

Use integer micro-USD (one million units per dollar), never floating point dollar
balances. Each user has a rolling 5-hour and a rolling 7-day limit (deployment
defaults, optional per-user overrides set by an administrator with a reason;
administrators consume usage too). Settled usage counts at its settlement time and
open holds count now. The former calendar-month allowance and its grants are kept
as history only.

Before externally chargeable work, reserve its upper-bound cost atomically against
the monthly fleet limit and the lifetime fleet limit; a new turn or VM start is
refused while a user window is exhausted. The
lifetime limit is necessary when funding free usage from a finite promotional
credit balance. User grants cannot change either fleet limit.

Each reservation has a stable UUID and resource key. Retries reuse an unsettled
reservation only when owner, resource and amount match. Settled reservations cannot
authorize another execution. All builders and chats draw from the same owner
balance. Unknown remote outcomes retain their full reservation, including across
month boundaries. Only trusted provider reconciliation can settle a hold and release
its verified unused amount; there is no browser-accessible refund path.

The ledger serializes short transactions using a separate PostgreSQL advisory lock.
No model, VM or other network call runs inside that transaction. RLS and revoked
browser-role grants keep the tables server-only; privileged server callers still
must perform explicit authorization.

## Configuration and rollout gates

Required configuration for the ledger:

- `YTIMESY_USER_5H_MICRO_USD` and `YTIMESY_USER_WEEKLY_MICRO_USD`: each user's 5-hour and 7-day limits (deploy defaults $5 and $25). They reset the way Claude's do: the first usage after a window ends starts the next one (`infrastructure_usage_window.started_at`), its reset time is fixed then, and at that time all of its usage clears. Running machines' open holds always count in the current window. `infrastructure_usage_policy.five_hour_micro_usd` / `weekly_micro_usd` override them per user. An exhausted window refuses new turns, subagents and VM starts (unless that VM's own session still has a turn running) and names when it reopens. Work already running finishes up to a hard ceiling per window: the limit plus about one hour of the running machine's runtime. Holds of running machines shrink to fit under it, and past it nothing extends.
- `YTIMESY_FLEET_MONTHLY_MICRO_USD`: monthly fleet execution ceiling.
- `YTIMESY_FLEET_LIFETIME_MICRO_USD`: aggregate execution ceiling over all months.
- `YTIMESY_ADMIN_USER_IDS`: comma-separated exact Better Auth user IDs. Empty grants
  nobody authority. No client role, display name or email supplies admin rights.

`YTIMESY_INFRASTRUCTURE_ADMISSION=true` activates native runtime caps on ordinary
session creation, environment setup, resume, repository commands, writes and PTY
starts. Public activity on enrolled machines extends funded runtime through the
worker sweep. Model billing and operator authentication/proof machines remain
separate. No production rollout or existing-user-VM deletion is included.

Freestyle's runtime counter updates after pause. Admission buys bounded chunks
with a prepaid 60-second stop buffer; active extensions use conservative elapsed
wall time and never refund running machines. Native caps survive worker failure.
Paused reconciliation lowers and confirms the native cap BEFORE settling unused
credit. Unknown provider outcomes retain holds, including across month changes.
A confirmed deleted VM generation requires a new reservation on recovery.

Verification: 17 ledger/provider fixture tests passed; real PostgreSQL concurrent
full-balance admission permitted exactly one reservation. A disposable native-cap
VM paused after 23 seconds against a 20-second cap and refused restart (409).
Disposable ordinary session proofs verified owner holds, native caps, pause/refund
and funded resume. All proof VMs were deleted; no paid inference was used. This
does not establish a provider-guaranteed maximum overshoot or 10,000-user capacity.

Remaining rollout work:

1. Enroll legacy preview auto-wake paths and account for operator machines before
   claiming that every existing resource is covered.
2. Prove the final admin UI with genuine authentication, separately from the local
   preview and server-authority tests. An admin-only recent-adjustment audit view
   is implemented; its live authenticated rendering still needs verification.
3. Connect actual billing data for transfer, snapshots and discounts before claiming
   a complete invoice limit. The admin fleet observation now inventories all VMs,
   including the worker and paused disks, plus snapshot count. Its active compute
   and 30-day disk amounts are retail projections, not accumulated invoice charges.
   Finalized usage can now be imported through the genuine-admin settings view as
   a normalized JSON statement. Imports are immutable, audited, idempotent, and
   reject overlapping account periods. An admin import is a recorded claim, not
   independent provider verification. The VM API key cannot access Freestyle's
   billing surface; automatic reconciliation still needs authenticated billing
   access. Missing categories are `null`, not zero. Statements do not silently
   replace the compute admission ledger or deduct provider credits from usage.
4. Expand retention beyond newly enrolled session machines only after proving the
   remaining machine categories. The bounded full-state recovery implementation is
   deployed in development; see workspace-retention.md for exclusions and proofs.
5. Load-test multi-replica admission and recovery. Never delete a user VM to test
   budgeting or automatically refund an uncertain provider operation.

### Finalized statement format

Use the amounts actually shown in a finalized provider usage statement, in integer
micro-USD (one dollar = 1,000,000). Gross resource charges are before account
credits, discounts and tax; do not import credit purchases as resource usage.
Periods are UTC instants with an exclusive end. Only import disjoint finalized
periods, not repeatedly changing month-to-date observations. Keep the original
provider statement separately for review. No credentials belong in this file.

```json
{
  "provider": "freestyle",
  "accountId": "acct-example",
  "sourceId": "usage-2026-09",
  "periodStart": "2026-09-01T00:00:00Z",
  "periodEnd": "2026-10-01T00:00:00Z",
  "computeMicroUsd": 1000000,
  "diskMicroUsd": 200000,
  "snapshotMicroUsd": null,
  "transferMicroUsd": null,
  "otherMicroUsd": null,
  "grossMicroUsd": 1500000
}
```

This is an illustrative format, not an actual bill. A zero category means the
provider explicitly reported zero; `null` means the breakdown was unavailable.
Known categories cannot exceed gross usage. When every category is known, they
must sum exactly to the gross total. Browser database roles cannot read or write
the statement table; the application enforces genuine administrator sign-in.
