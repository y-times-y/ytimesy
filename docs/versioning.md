# Versioning

Status: proposal, 2026-11-24. No tag, release, npm publish or deploy has been made.

## Current version estimate

**v0.0.11** (milestone 11, Y² thread messaging, 2026-11-19; main tip 2026-11-24, 2189 commits).
Confidence: medium. Order and dates come from commit messages and dates; what counts as a
milestone is a judgement. Splitting more finely gives about 18, merging more gives about 8.
Pace: 11 milestones in 73 days, about one every 6.6 days and about 200 commits each.

## Rules (pre-1.0)

- One version for the whole monorepo: the product version in `package.json` and the git tag.
- **Patch** (0.0.N): each milestone, meaning something a user would name: a new capability,
  route, integration or platform move. Milestones are numbered consecutively: v0.0.1, v0.0.2, ...
- **Minor** (0.N.0): only when the owner decides a new phase has begun (for example the desktop app
  shipping). Never automatic.
- Work that is not a milestone is not versioned; it is covered by the next release's notes.
- 1.0.0 is a deliberate decision by the owner.
- The product version must never be lower than a published package version (see below).

## npm packages (open conflict)

`ytimesy` (packages/ytimesy-cli) is published as 0.0.0-stage (2026-11-01), 0.1.0 (2026-11-01),
0.1.1 (2026-11-02), 0.1.2 (2026-11-07); the repo's package.json says 0.1.1, so 0.1.2 was published
without a committed bump. npm versions cannot go down, and **0.1.2 is above v0.0.11**, which breaks
the rule that the product version is never lower than a published package. Options:
(a) the CLI keeps its own number (0.1.x) and release notes record which product version it ships
with, until the product passes it; (b) take the first minor bump at the next milestone, v0.2.0, which
is above 0.1.2, and align the CLI to the product from then on. Recommendation: (b). The desktop app
(Electron) has no commits in this repository yet, so it takes the product version when it lands.

## Milestone to version table

Hashes are the current main hashes (history was rewritten on 2026-11-24; do not use older ones).
`node scripts/version-history.mjs` regenerates this table and the patch tags (read-only).

| Version | Date | Commit | Milestone |
|---|---|---|---|
| v0.0.1 | 2026-09-13 | 5aaa0308 | Sign-in, GitHub onboarding, Freestyle cloud VMs, first agent chat on Codex (first tag; first commit 2026-09-12 afabb045 is "hello world") |
| v0.0.2 | 2026-09-14 | d1e4be08 | Pull requests from the app, Claude and OpenCode harnesses, parallel chats |
| v0.0.3 | 2026-09-27 | ca092a27 | Multi-provider API models, reusable environments, Codex subscription on the shared harness (10-01, 16c05b18) |
| v0.0.4 | 2026-10-08 | 8fd1f0bc | Cloudflare runtime (workflows, Workers fa037d25, Durable Objects), Terminal-Bench evals, plugins and MCP, production deploy tooling (b10b7d05) |
| v0.0.5 | 2026-10-18 | 565f325c | Subagents and memory (abd0f088) |
| v0.0.6 | 2026-11-01 | e36d7fd5 | SuperGrok and Claude Code subscription routes, CLI and session import (a23f3372) |
| v0.0.7 | 2026-11-10 | 0162b378 | AWS runner boxes for Codex proxy and Claude Code |
| v0.0.8 | 2026-11-14 | bea64766 | Canvas |
| v0.0.9 | 2026-11-16 | a2ba013b | Y² super agent |
| v0.0.10 | 2026-11-17 | 1bf700bf | Public repository, MIT licence, CI |
| v0.0.11 | 2026-11-19 | 2368be61 | Y² thread messaging |


Caveats: the exact production go-live date is not recorded in git (docs/production-launch.md was
still "behind Access" on 2026-10-14), so v0.0.4 includes the deploy tooling, not the go-live.
Several milestones landed on branches merged later; dates are commit dates of the first
commit that introduced the capability.

## Release process going forward

1. Tags are annotated, `vX.Y.Z`. Patch for each milestone, minor only by owner decision (rules above).
2. A lightweight `deploy-YYYY-MM-DD-<build>` tag marks each production deploy (optional; separate from product versions).
3. Release notes are generated from merged PRs since the previous tag (`gh release create --generate-notes`), grouped by label.
4. A script (`scripts/release.mjs`, to write) computes the next version, bumps `package.json` files, and prints the notes; a GitHub Actions workflow runs it on a schedule/manual dispatch.
5. The GitHub App lacks the `workflows` permission, so the workflow file is added by hand by the owner.
6. Tags and release commits use the AGENTS.md identity: the checkout's configured identity, else `ytimesy-agent[bot] <328807657+ytimesy-agent[bot]@users.noreply.github.com>` with the `Co-authored-by` trailer; never an invented one.
7. Nothing is tagged, pushed or published without the owner's explicit approval.
