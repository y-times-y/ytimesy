# Recursive Task Architecture

This document defines the product's agent orchestration contract and records
the implementation boundary. Runtime adapters implement the contract but do
not decide its semantics.

## Durable lead threads

A root thread is the durable coordinator for one piece of work. Its history,
task tree, machines, messages, and review state survive browser disconnects and
process restarts. External events such as task completion or CI can wake an idle
lead without requiring the browser to remain connected.

## Draft before execution

The lead decomposes work into editable task drafts before spending compute. A
draft contains:

- a concise title;
- a complete standalone prompt;
- the runtime and model;
- read-only or read-write access;
- shared or fresh machine placement;
- parallel or stacked execution; and
- an optional predecessor for stacked work.

Creating a draft has no runtime side effect. Starting it is a separate,
validated transition.

## Isolated task context

A task begins with its prompt alone. It does not inherit the parent transcript,
private reasoning, tool output, or partially explored context. The prompt must
therefore contain the objective, relevant paths, constraints, expected evidence,
and prohibited changes.

The child receives the standalone task prompt, not automatically selected
project briefings, sibling traces, or the parent transcript. Parents receive
explicit progress and final-summary messages. They do not ingest the child's
full transcript automatically. This keeps both contexts small while preserving
a durable audit trail in the child thread.

## Recursive task trees

Every task is a full agent and may draft and start children under the same
contract. The hierarchy is positional: Task 1, Task 1.1, Task 1.2, and so on.
Delegation is limited to three task levels. The lead chooses the smallest
coherent task decomposition; infrastructure quotas are enforced by the runtime
rather than by an invented fixed task-count limit.

## Placement follows write access

Read-only tasks share the parent's machine and inspect its exact working tree,
including uncommitted changes. Each conversation has session-scoped daemon
state, process IDs, logs, turn output, and task-tool mailboxes, so concurrent
readers do not overwrite one another. The runtime also receives an enforced
read-only mode; a prompt request alone is not sufficient protection.

Read-write tasks use a fresh machine. Parallel writers start from the clean
project snapshot and must own disjoint work. Stacked writers start from their
completed predecessor's reviewed state so dependent or overlapping changes are
applied in order.

The selected placement and machine identity are recorded before execution and
are visible to the lead.

## Parallel and stacked execution

Parallel tasks may run simultaneously only when their expected write sets do not
overlap. Each produces an independent deliverable.

Stacked tasks declare a predecessor. They remain drafts until that predecessor
is done, reviewed, and published. The successor then boots a clean machine,
fetches the predecessor's published branch, and uses that branch as both its
starting state and pull-request base. It never depends on an unpublished VM
snapshot. When independence is uncertain, prefer stacked execution because
waiting is cheaper than resolving a conflict after parallel work diverges.

## Coordination and wakeups

Leads continue useful local work while children run. They inspect progress at
meaningful checkpoints, send corrections when a task drifts, and request an
early wrap-up when waiting would delay the outcome.

A final child summary and terminal state are saved atomically with a durable
outbox event. A background worker claims the event idempotently and wakes the
parent. If the parent is busy, delivery waits for its next idle point. Ordinary
progress does not create a wake event. A blocked child records `waiting` and
sends its concrete question through the same outbox; the parent answers,
escalates to the user, or changes the plan.

## Review and delivery

Completion does not automatically publish a child's changes. The parent first
reviews the child diff and evidence. It may accept the result, send targeted
feedback, repair a small issue, or reject it. Publication is an explicit task
tool action after review and records the branch and pull-request URL for later
stacked work.

## Machine and session identity

A machine and an agent session are different identities. A fresh writer owns a
machine. Multiple read-only sessions may point at the same machine while keeping
their conversation runtime state separate. Starting a task returns both its
selected placement and machine identity so the decision is observable.

A draft owns no machine. Machine binding happens only during the validated start
transition.

## Model routing and accounting

Each task stores its runtime and model independently. Defaults inherit from the
parent, while the lead may route mechanical work to a cheaper model and
difficult work to a stronger model. Provider-specific reasoning and speed
controls remain session settings rather than task-graph fields.

Tree-wide usage aggregation and hard budget enforcement are not implemented
yet. Runtime capacity errors are enforced by the infrastructure provider, and
the control plane does not invent a smaller fixed task-count limit.

## Implemented control-plane paths

- `create_task` persists an editable draft without provisioning a machine or
  starting a model turn.
- The lead revises drafts through `edit_task`. The task panel is a read-only
  progress overview; users steer delegation through chat, not task controls.
  Both paths validate the same stored task before execution.
- `start_task` validates depth, placement, access, and stacked dependencies,
  binds the machine, starts the isolated prompt, and returns placement plus
  machine identity.
- Shared read-only sessions point to the parent's machine while command and
  file paths for daemon state are namespaced by session.
- Fresh writers provision from the clean project template. Stacked writers
  fetch the reviewed predecessor's published branch into a fresh machine.
- `report_task_blocked`, completed turns, and failed turns write durable,
  deduplicated events. A worker leases events, retries abandoned leases, waits
  while a parent is busy, and wakes the parent when it is idle.
- `inspect_task_diff` and `mark_task_reviewed` keep review separate from
  completion. `publish_task` creates the task's branch and draft pull request,
  then records both identities for dependent work.
- Deleting a shared child removes its session record but never destroys the
  parent's machine. Deleting a task tree destroys only machines owned by fresh
  descendants.
- Each runtime task-tool request has a durable command receipt. A repeated
  request returns its recorded result; an old request with an unknown outcome
  requires inspection instead of blindly replaying a VM or publication action.
  Long operations renew their receipt while the executing process is alive.
- A separate worker revisits persisted running turns after web-process loss and
  resumes supervision. The task event outbox continues delivering parent wakeups.
- Authenticated project images are private, provider-specific snapshots. They
  combine the user's provider login with the prepared checkout once, then new
  writers copy that image without reinstalling dependencies. The control plane
  stores only a fingerprint of the source login snapshot in the template record.

## Verification boundary

The task graph, validation, session namespacing, wake-event delivery, database
migrations, publication metadata, and deletion behavior are covered by the
automated test suite. A live UI pass has verified draft creation and editing,
and a live non-Node repository setup reached `ready` with a private project
snapshot. Neither test proves a provider-backed nested task. Live multi-machine validation still
requires available infrastructure capacity and is tracked separately from
local tests and build checks.
