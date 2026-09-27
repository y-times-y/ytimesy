# Project environments

Implementation status (2026-09-27): the Rigkit preparation worker has been deployed with automatic hourly refresh paused. Disposable VM checks verify command execution, timeouts, private snapshot restoration, and service startup. An authenticated UI-created two-repository project reached installation and verification through the real queue and worker. Successful activation for that project remains unverified: the published primary branch fails its TypeScript checks. The temporary project and builder were removed; its GitHub repositories were not modified.

Recovery-policy update (same day): advisory code checks and bounded Codex-assisted install repair are deployed to the existing worker. Remote source equality and the disabled refresh flag were verified; existing agent/template VMs remain paused. Local regression tests cover non-blocking baseline failures, mandatory verification failures, bounded retries, repair capability validation, subscription-only diagnosis, and credential cleanup. This is not yet live model-driven repair or a fresh successful two-repository activation proof.

Selected-model update (same day): repair now routes through the explicitly selected Codex subscription model or verified API connection. The existing worker was updated, and deployed routing/runtime/worker source equality was verified. Automatic environment refresh remains disabled. Routing tests cover all five API adapter types; these are fixture tests, not live inference proof for each provider.

## Preparation and reuse

The project owns a prepared snapshot, not an agent's working machine. The queue starts a Bun subprocess running the pinned Rigkit engine. Its trusted workflow provisions a builder from the tools image, checks out the authorized repositories, installs dependencies, verifies each repository, and activates a private snapshot. Each writer later gets a separate copy; reconnecting uses that writer's existing VM.

An input fingerprint includes the authorized repository revisions, tools image, and encrypted secret revisions. An unchanged scheduled check skips setup only after confirming the private snapshot still exists. A failed replacement leaves the previous successful snapshot active. Builders have a one-hour runtime limit; abandoned build claims can be reclaimed after seventy minutes, before a seventy-five-minute queue expiry. Shutdown attempts graceful cleanup, then kills an unresponsive subprocess. Cleanup pauses the builder, not an existing agent machine.

`YTIMESY_ENVIRONMENT_AUTO_REFRESH=false` disables the refresh queue and hourly sweep, not explicit project setup. The deployment script accepts this environment variable for a bounded rollout. Workspace status reads never enqueue builds.

## Repository configuration

Commit `.ytimesy/environment.json` in each repository. Do not put secret values in it.

```json
{
  "version": 1,
  "install": "corepack pnpm install --frozen-lockfile",
  "buildSecrets": ["PACKAGE_TOKEN"],
  "verify": ["corepack pnpm run typecheck", "corepack pnpm run build"],
  "services": [
    {
      "name": "web",
      "command": "corepack pnpm dev --host 0.0.0.0",
      "port": 3000,
      "timeoutSeconds": 60
    }
  ],
  "timeoutSeconds": 900
}
```

Install and verification commands run in that repository inside the VM, with `CI=true`. The timeout is per command, subject to the whole-build limit. Commands over five minutes use Freestyle's PTY API and a guest-side timeout, rather than a silently shortened HTTP execution timeout. PTY cleanup kills the session; it does not merely detach.

`buildSecrets` explicitly selects names from the project's existing encrypted secret store. Missing names fail setup. Decrypted values are passed to the guest process, not persisted in Rigkit inputs, outputs, or progress events. Changing secrets during preparation prevents activation. Build tools can still write credentials into artifacts: setup scripts must not embed private values in generated files. Private snapshots are not a substitute for that discipline.

Without a recipe, Node projects use the existing lockfile-aware installer. Available typecheck/build/test scripts run as advisory baseline `checks`, not activation gates. Each check has a maximum two-minute runtime; exit codes (including timeouts) are saved with the repository revision in the prepared manifest, without raw output. The task agent is instructed to read this baseline, reproduce relevant failures, and make task-scoped fixes on its own branch. Unrelated code changes are not authorized by setup. Projects without tests can still prepare successfully. Provider/transport failures remain fatal rather than being mislabeled code failures.

An explicit recipe's `verify` commands remain mandatory environment-readiness gates. Use `checks` for advisory application tests. This preserves existing explicit gates without guessing whether arbitrary user commands are optional.

Failed dependency installs can be diagnosed with the explicitly selected model by choosing **Repair with selected model** in project setup. Ordinary preparation, scheduled refresh, and **Retry** do not select a model or authorize inference. The repair job freezes the model selection; no alternate provider is chosen on failure. Codex uses the connected subscription and exact discovered model. API models use the existing shared harness adapters for OpenAI, Anthropic, Google, OpenRouter, and compatible endpoints. The connection must belong to the user and the model must be verified; a changed or deleted connection stops the queued repair. API authorization is explicit in the repair button, and credentials stay on the server.

Diagnosis can only propose validated capabilities: retry the original install, enable Corepack shims, or install an allowlisted Ubuntu build dependency. The host never executes model-written shell. Two repair attempts per repository are allowed; each diagnosis turn is capped at two minutes after connection, each repair command at three minutes, and the whole builder retains its one-hour limit. API diagnosis allows one model step with no tools and at most 512 output tokens; conservative reservations share the existing account budget and enforce a separate 100,000-token daily environment budget. These token budgets are safety bounds, not dollar caps. Explicit repair jobs disable automatic queue retries. Codex credentials are removed and its diagnosis daemon stopped before continuing. Unsupported repairs, missing credentials or secrets, and exhausted retries fail setup; the last good snapshot remains active. This is intentionally not a general-purpose agent with unrestricted access to modify source or setup configuration.

No diagnostic model is used for a successful install. Non-Node projects still need an explicit install recipe. This does not infer every language's toolchain or guarantee a comprehensive test suite.

Services start after a session restores the snapshot and receives its runtime secrets. Named tmux sessions prevent duplicate starts; startup waits for the configured local TCP port. Different repositories must use different ports. A provider outage is an error, not evidence that no services were configured.

## Remaining rollout work

- Complete successful authorized multi-repository activation and restored-session verification against branches that pass their setup checks.
- Complete per-repository diff/publication presentation and storage of multiple pull requests.
- Add snapshot retention/resource cleanup for superseded and failed builds.
- Dockerfile-based base images, guided setup, configurable network policy, and prewarmed pools are not implemented by this workflow.

Baseline checks need no model inference. Authorized diagnosis consumes the selected subscription or API connection. Provider-independent routing has regression coverage; live API diagnosis is pending because the linked database currently has no saved model connections. No live inference charge was incurred for this update.

## Verification record

- Local typecheck and production build pass. Superseded preparation/refresh implementations were removed; regression tests now target the shared checkout and Rigkit build stages.
- Live PTY completion/timeout, two-repository fixture snapshot/restore, service readiness, and duplicate-start checks passed; their resources were deleted.
- Real UI creation selected two authorized repositories, and the deployed worker cloned and installed both. This exposed a missing `pnpm` executable for nested package scripts. Shared setup now enables Corepack shims in the guest user's local bin directory; the command was retested in the VM.
- With the executable fixed, the published `ytimesy` master revision still reports TypeScript route-definition errors. Running its build first does not resolve them. Its build and the secondary repository's build pass. That test preceded the advisory-baseline policy; no successful snapshot was activated then. The new policy records rather than suppresses this failure and needs a fresh live activation test.
- Final rollout inspection caught status reads enqueueing refreshes outside the hourly scheduler. That read-side mutation was removed and regression-tested. Eight extra rollout builders were deleted, their jobs canceled, and the original template and agent VMs preserved. The refresh gate now covers individually queued refreshes as well as the hourly sweep.
