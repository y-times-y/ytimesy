# Captain scope across threads

Verified against current first-party documentation on 2026-10-08; no authenticated API calls or inference runs.

**Captain is a long-running thread that coordinates other threads assigned to its crew.** It is more than the leader of child subagents inside a single ordinary thread. The inspected sources do not establish automatic visibility into every thread in an organization.

- The [September 24 changelog](https://capy.ai/changelog) introduces Captain under Experiments and defines it as a long-running thread directing other threads as its crew. The same section says Memory and Captain can be enabled for oneself or the organization; organization-level enablement is not evidence of organization-wide transcript access.
- [Create Captain](https://docs.capy.ai/api-reference/captains/create-captain) requires `requestId`, `projectId`, and `name`; optional `brief` provides its first instruction. It requires a human owner. This establishes project-associated creation, not a global organization supervisor.
- [List Captain crew](https://docs.capy.ai/api-reference/captains/list-captain-crew) exposes `GET /api/v1/captains/{captainId}/crew` and returns `items` of `ThreadEncoded`. Crew members are threads, not merely records of the subagents/tasks API. Thread metadata includes an optional `captain` relation and crew counts. This supports an explicit managed-crew relationship.
- The [October 1 changelog](https://capy.ai/changelog) says a Captain now hears direct answers a crew thread gives the user, including approved merges. It also says a running thread added to the crew receives Captain Drive on its next step. This is concrete documented notification/shared-drive behavior for crew members, not proof that all unrelated threads are automatically ingested.
- [Get Captain digest](https://docs.capy.ai/api-reference/captains/get-captain-digest) returns the text of `DIGEST.md`, falling back to `ONGOING.md`, then Captain's `NOTES.md`. It can be null before the Captain writes a file, or if it is binary or exceeds 64 KiB. `updatedAt` records when the Captain Drive last changed. This is file-backed authored state, not a guaranteed complete snapshot of all thread transcripts.

The older Captain description in [Capy's agentic-coding article](https://capy.ai/articles/agentic-coding) describes planning implementation tasks for Build agents. That older planning role should not erase the current September/October persistent Captain-and-crew product behavior. This follow-up did not independently inspect an alleged March-specific release and does not assert a March release date.

Evidence boundary: current docs establish that Captain can coordinate multiple crew threads and receive specified crew events. They do not establish the exact transcript retrieval tools, whether every historical crew message enters its context, access to unrelated threads, or internal context-management implementation. No production Captain was created or exercised.
