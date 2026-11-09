# Claude SDK image maintenance

The production SDK is pinned, not auto-updated inside running agents. On 2026-11-09 the official npm registry's latest `@anthropic-ai/claude-agent-sdk` release was **0.3.321**, bundling Claude Code **2.1.321**. That is the pin in `src/domain/guest-cli-pin.ts`.

## New machines

`scripts/production-tools-image.ts` records the matching private, clean tools snapshot. Production deployment uses that image even if an older `YTIMESY_TOOLS_SNAPSHOT_ID` remains in an operator's environment. Changing the SDK pin without updating this verified image makes deployment fail rather than silently shipping an old base image.

The verified snapshot is `sh-12db89b56a6044e895fddd638ed4f946`. It was built from the previous clean tools image, never from a user's chat machine. A fresh copy successfully imported the SDK and ran its executable as both the Builder user and `ytimesy-reader`. Temporary build/verification machines were deleted. The old image is retained for rollback.

```sh
node --import tsx scripts/build-tools-snapshot.ts --refresh-sdk
node --import tsx scripts/build-tools-snapshot.ts --verify <new-snapshot-id>
```

The refresh command requires the previous clean `YTIMESY_TOOLS_SNAPSHOT_ID`, accepts only private `ytimesy-tools-*` sources, and only updates the SDK. It does not upgrade unrelated compilers, Node, or project dependencies. The recipe hash includes the source image and SDK installation recipe.

An old snapshot's cached npm metadata may not contain a newly released SDK. Installation revalidates metadata against the official npm registry (`--prefer-online --registry=https://registry.npmjs.org`) while npm can still reuse downloaded package contents. Preferring offline metadata caused a real `ETARGET` on the old tools image during validation; that failed build was removed and the corrected build passed.

## Existing project machines

```sh
node --import tsx scripts/refresh-workspace-sdk.ts --session <owned-chat-id>
node --import tsx scripts/refresh-workspace-sdk.ts --session <owned-chat-id> --apply --refresh-templates
```

The default is inventory-only. Add `--vm <machine-id>` to inventory or retry one machine without waking machines already verified; ownership and purpose checks still apply. Apply mode:

- Restricts maintenance to the named chat owner's database-bound workspace machines with `ytimesy-workspace` metadata. Other users' machines, relay services and unrelated/unbound machines are excluded.
- Uses normal infrastructure admission before resuming a machine and during setup. It does not disable quotas or replace runtime caps manually.
- Installs the pinned SDK alongside old releases; running Claude processes keep their original executable.
- Runs machines sequentially to avoid a burst of cold-start requests. SDK-only probes and journaled installer operations have bounded transient retries; model inference and user commands are not retried by this maintenance.
- Keeps idle policies intact and never force-pauses a machine a user might have opened during maintenance.
- Optionally refreshes private project template snapshots after successful installation. It refuses sources used as chat machines or being rebuilt. Updating the workspace pointer is owner-scoped and compare-and-swap fenced; the previous snapshot stays available.
- Reports missing/retired VM bindings without recreating them. Those are recovered through the existing lifecycle when the chat is resumed.

Both production Workers' boot-image setting was updated to the verified image on 2026-11-09. The turn-recovery application fixes and image pin then shipped in build `18e920b47843-mw9w8pux`; production preflight and the home-page, web-version and edge-health smoke checks passed. Existing projects use their own templates, so those also need the maintenance command; changing only the shared base image is insufficient. Fleet maintenance completion is reported separately from application deployment.
