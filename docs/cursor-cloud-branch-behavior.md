# Cursor Cloud branch behavior

Verified against official Cursor documentation on 2026-09-30. Pages were read with agent-browser; no authenticated product interactions, agent launches, API mutations, or paid tasks were performed.

## Base branch and working branch

Cursor documents a dashboard **Base branch** setting: agents fork from it when creating pull requests; leaving it blank uses the repository's default branch. This is a starting-point default, distinct from the branch containing an agent's changes. [Cloud Agents settings](https://cursor.com/docs/cloud-agent/settings#default-settings)

The v1 creation API accepts `repos[].startingRef` (branch or commit SHA). With `workOnCurrentBranch: false` (default), commits go to a generated `cursor/...` branch based on that starting ref. With `true`, commits go directly to the supplied starting branch. For `prUrl`, `startingRef` is ignored: the default creates from the PR base; `true` writes to the PR head. The pushed branch appears in `git.branches[]`. [Create an agent](https://cursor.com/docs/cloud-agent/api/endpoints#create-an-agent)

The docs establish branch behavior at creation, but do not specify the exact UI moment or Git command at which the working branch is created. Do not equate selecting a base branch with writing to it.

## Isolation and follow-ups

Each cloud agent has its own isolated VM with a full desktop environment. Cursor's general workflow clones the repository, works on a separate branch, and pushes changes for handoff. The explicit API direct-write option above is an exception to that general branch description. [Cloud Agents help](https://cursor.com/help/ai-features/cloud-agents#can-cloud-agents-test-my-app-in-a-browser), [Cloud Agents overview](https://cursor.com/docs/cloud-agent#repository-provider-connection)

API follow-ups use `POST /v1/agents/{id}/runs` and retain the current conversation and workspace. Only one run may be active per agent; a concurrent request returns `409 agent_busy`. [Create a run](https://cursor.com/docs/cloud-agent/api/endpoints#create-a-run)

Inference: follow-ups continue the existing workspace rather than selecting a fresh base and allocating another agent branch each turn. This follows from workspace retention; it does not establish behavior after arbitrary shell-level Git changes.

## Changing branches: proof boundary

The documented follow-up request contains no branch/base override, and the endpoint inventory has no branch-switch endpoint. A different starting branch can be supplied when creating another agent. This does **not** prove that branch switching through an agent prompt, terminal, or product UI is impossible. [API endpoints](https://cursor.com/docs/cloud-agent/api/endpoints)

Not directly tested: the web/desktop branch picker, when it becomes editable or locked, existing-agent branch switching, branch-name customization, and follow-ups after a user manually changes Git state. These require authenticated UI or live execution evidence before being described as product facts. The v1 API is public beta and may change. [API status](https://cursor.com/docs/cloud-agent/api/endpoints#public-beta)

## Implemented application policy

The picker stores an owner-scoped selection on the chat, not on the project or its template machine. On a new chat's first submission, the selected source becomes its base branch and a unique working branch is assigned. Follow-ups retain that working branch. An explicit branch change in an existing chat is applied verbatim on the next submission, with dirty-checkout protection. This last interaction is our policy, not a verified Cursor UI behavior.

Native and API runtimes use the shared checkout preparation. Read-only shared children do not switch the parent checkout. Root-chat publication retains the working branch and selected base. Legacy conversations retain their existing checkout unless the user explicitly selects another branch.

Verification: development migration applied; owner-isolation and submission-policy regression tests; real local Git tests for divergent branches and dirty edits; browser picker selection checked without inference. Paid model execution of a newly submitted task was not exercised in this change.
