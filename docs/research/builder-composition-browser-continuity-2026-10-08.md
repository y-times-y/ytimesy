# Builder workflow: composition, browser and continuity

Implemented on `codex/builder-core-tools`, following the existing command lifecycle and image-inspection work. These mechanisms do not establish superiority over native Codex or fewer requests in real coding tasks.

## Result-dependent tool composition

`compose_tools` accepts up to eight forward-only steps using existing tool schemas. Independent reads overlap (at most four); commands and edits require explicit serial dependencies. Arguments can reference an earlier declared dependency with `{"$result":{"step":"read","path":["reference"]}}`.

The executor invokes the already-authorized and wrapped tools, preserving repository read fences, hooks, journal identities, output cursors and individual chat tool cards. It does not execute model-authored JavaScript on the server. Recursive composition, task launches, publication, provider-native tools and image payloads are excluded. Failed, interrupted, stopped, deferred or still-running prerequisites block dependent work. It never silently retries uncertain mutations.

This is bounded declarative dataflow, not a general-purpose programming runtime. Dynamic results remain untrusted input and are validated against each receiving tool's schema.

## Browser Use

`browser_execute` runs Python through Browser Use's current stdin interface inside the writable task VM, using the existing durable command lifecycle. It attaches to the task's local Chrome endpoint, not a user's personal browser. Existing screenshot tools supply image pixels; paged output and command continuation remain available.

The install adapter pins Browser Use `0.13.11`, checks the installed Python package metadata, and disables telemetry and recordings. Browser Use's `--version` reports the underlying Browser Harness version, so it is not a valid package-version guard. Installation is locked and reused. Session socket paths are deliberately short to respect Unix socket path limits. No Browser Use Cloud credential or billing integration is introduced.

Primary references inspected:

- [Browser Use package metadata](https://pypi.org/project/browser-use/0.13.11/)
- [Pinned CLI implementation](https://github.com/browser-use/browser-use/blob/0.13.11/browser_use/cli.py)
- [Pinned CLI instructions](https://github.com/browser-use/browser-use/blob/0.13.11/browser_use/skills/browser-use/SKILL.md)
- [Pinned package dependencies and MIT licensing](https://github.com/browser-use/browser-use/blob/0.13.11/pyproject.toml)

## Long-task continuity

`update_plan` saves a bounded objective, steps, evidence and remaining work; `read_work_plan` retrieves it. Writes lock the owned session and require the expected revision. The canonical record reuses the existing command-receipt table; no migration is needed. Separate journaled calls preserve earlier update receipts.

The latest plan is rehydrated into the model's context on restoration and message preparation, including after compaction. It supplements existing archived-history search, project memory, repository instructions and delegation state. It does not overwrite opaque provider messages. Evidence is an agent claim, not independent acceptance verification. Plans must not contain secrets.

## Verification boundaries

- Full local suite: 315 files passed, one skipped; 1,654 tests passed, seven skipped.
- TypeScript, production build, changed-file Biome checks and `git diff --check` passed. The full suite passed again after the command-interruption guard; targeted plan and composition tests also passed after the final cancellation guard.
- A mocked model-loop test composes two result-dependent reads in one inference and retains leaf events and metrics. This is a mechanism test, not a live efficiency benchmark.
- Real Browser Use CLI on a disposable local Chrome instance: navigation, tab reuse across CLI calls, click, changed-text assertion and valid PNG capture passed. The test removes its own daemon and temporary files.
- Database fixtures verify independent reads, owner isolation and stale-revision rejection.

No paid inference, new Freestyle machines, deployment, main-branch merge or competitor benchmark was performed. Cold installation and end-to-end browser execution inside a fresh Freestyle VM remain unverified.
