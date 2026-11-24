# main vs branches audit, 2026-11-24 (read-only, not committed)

Sources: `git fetch origin --tags --prune`, `git merge-base --is-ancestor`, `git patch-id --stable` against the last 600 commits of origin/main, subject matching, `git merge-tree` dry merges, the unauthenticated GitHub API (PRs #1-#15; #16 does not exist) and https://ytimesy.com.
Not readable: no GitHub token (no authenticated data, no CI/deploy runs), no R2 (box program version), no Cloudflare/AWS state, thread reports (not read; the "committed locally, not pushed" check in step 4 was not done).

## Production
- `/api/version` and the `x-ytimesy-build` header both say `bc12723df3be-mwv44uln`.
- origin/main HEAD is `bc12723d`. Production therefore runs the head of main, and every commit on main from the last 3 days is in the deployed web/edge build. The earlier ids (261d4760, 40d6bb5f, c173ca0b) are ancestors of it.
- Box program version: could not read (published separately to R2). Check it by hand.
- The edge build includes no migration 20261124120000 (see g).

## Branches and PRs (the PR numbers do not match the thread numbers in the request)
Branch / PR / state / commits not in main / merge dry-run:
- add-gemini-neon: no PR. Same patch in main (08141e5d). Content merged.
- agents-ux-base: PR #9 open, +5225/-800, 8 ahead, 35 behind. Most work is in main under other hashes. 5 commits are not in main by content (identity-fix builds 11, 14, 15, 17, 21, "publish older commits" rehearsal). CONFLICTS. Stale; review before closing.
- box-helpers, box-machine-git (PR #3 merged), make-y-super-agent-easy (PR #11 closed, head is an ancestor of main): fully in main.
- recovery/alchemy-iac-effect4: ancestor of main (b80e14d9).
- assess-alchemy-iac (PR #12 open): docs/alchemy-assessment.md is already in main. The branch still adds the unapplied PoC `infra/alchemy-poc/*`. CONFLICTS (docs file added on both sides). Superseded; close.
- fix-coordinator-could-fe6df0 (PR #8 open): patch is in main (lock fixes). Close.
- fix-subscription-not (PR #2 open), sidebar-all-threads (PR #5), make-harness-and-codex (PR #6), why-chat-was-slow (PR #7), thread-to-thread (PR #10), thread-y-marks: patches are in main under rewritten hashes. The PRs are open only because main was pushed directly. Close them.
- fix-turns-stuck-working-188a3e (PR #1 open, +53/-43, 2026-11-19): NOT in main by content (model picker, machine-failure). CONFLICTS. Stale 116 commits behind; decide whether it is still wanted.
- the-worker-disconnected-dd4984 (PR #4 open, +182): NOT in main. Turn-alarm repair (`turn-alarm-repair.ts`) was never committed to main; the commit subject says "not yet committed or deployed". Merges clean. 66 behind.
- interruption-proofing-no-74b3c8 (PR #14 open, +2590/-67, 9 ahead, 4 behind): NOT in main, by design (migration and deploy not approved). Its `20261124120000_interruption_monitoring.sql` is not applied. CONFLICTS with main (4 commits behind); rebase first.
- let-y-choose-and-change-c52d71 (PR #15 open, +2532/-39, 4 ahead, 1 behind): NOT in main, in progress. Merges clean.
- versioning-derive-a-v0-x-bdf863 (PR #13 open, +96): NOT in main (docs/versioning.md, scripts/version-history.mjs). Merges clean.
- pre-open-source-audit-aed4c3: unrelated history (no merge base; the pre-rewrite history), 2007 commits. Its recent patches are in main. Archive.

## Work items
a. Streaming relay fix (40c18253, 2026-11-23): on main, deployed.
b. Gemini 4 Neon (08141e5d): on main, deployed.
c. New-chat speed-up (fb58b690, same patch as bebc6588): on main, deployed. PR #7 still open.
d. Sidebar by state, Super agent per project, question-mark fix, canvas guidance (cdd88965, c99697c3, a79d25bc, f8abc126, 08dbbc99): on main, deployed. PR #5 open but redundant.
e. Y² UX (10653bcf, 82131681, 78c7bdff, 48258eb1, 04002d1b): on main, deployed. PR #11 closed unmerged, but the commits are on main.
f. Thread messaging (7da2281c, 9c211c5f, cdab56b6, 49e93b83, 261d4760 for names): on main, deployed. Docs on main. PR #10 open.
g. Interruption-proofing: NOT on main, NOT deployed, as expected. Code exists only on the PR #14 branch (pushed). Migration 20261124120000 exists only there. Related deploy-safety fixes (a624b4c7, d8ee9f38) are on main.
h. Lock/lease fixes (560d6fc9, 273c953f, c173ca0b, 40d6bb5f, bc12723d): on main, deployed. PR #8 open and redundant.
i. Alchemy IaC and Effect 4 (b80e14d9, b3f4abc9, 8090115f): on main. Deployed to production per the build id. Dev/production Cloudflare state is as reported by the thread (the docs say Cloudflare done, AWS open); not verifiable here. The files are infra/alchemy/*.run.ts (not alchemy.run.ts / infra.ts at the root).
j. Versioning docs: NOT on main. On the PR #13 branch. Tags on origin: only v0.0.1, v0.0.2, v0.0.3, v0.0.9, v0.0.10, v0.0.11 (all dated 2026-11-24). v0.0.4-v0.0.8 are missing from origin. Which commits they point to was not verified. v0.0.4-v0.0.8 exist only on the thread's machine, or nowhere. At risk.
k. Y² model per thread: PR #15, in progress, pushed, not on main.
l. Chip overflow (ca5f2e47), thread colour, bubble corners, version notice: chip overflow is on main and deployed. I did not confirm the others by name (thread-y-marks colour is on main as 29cb0ef3). Check bubble and version-notice commits by hand.
m. Git identity guard and AGENTS.md rules (a8e33a24, 5a0d51ef, 0c318803, c47813e8, managed-git-identity.ts, docs/managed-git-recovery.md): on main, deployed. The extra rehearsal commits on agents-ux-base are not.
n. Docs (thread-communication-vs-capy.md, alchemy-assessment.md, infrastructure-as-code.md): on main.

## Integrity
- Rewrite: pre-open-source-audit branch retains the old history. Every other branch has a merge base inside main's current history, so none is based on an old pre-rewrite line. The ones behind by 40+ commits conflict or will (PR #1, #4, #9, #12).
- Attribution: main commits are now authored by `ytimesy-agent[bot]` or `ytimesy <noreply@ytimesy.com>`. Commits of 2026-11-21..23 by "ytimesy agent <agent@ytimesy.com / .local>" and "Het Patel" still carry other identities. I did not identify the 16 rewritten ids; check whether this mixture is intended.
- Duplicates: the same work sits under two hashes on main and on PR branches (PRs #2, #5, #6, #7, #8, #10 are redundant). Commit 31b450fb carried only a test; 35748571 is the fix. I found no revert.
- Not checked: whether any thread reports "committed locally, not pushed".

## Recommended order
1. Close the redundant PRs (#2, #5, #6, #7, #8, #10, #12 after copying the PoC if wanted).
2. Land PR #13 (docs only), then push tags v0.0.4-v0.0.8 if they exist.
3. Land the turn-alarm repair (PR #4) after tests.
4. Rebase PR #14 onto main, then approve migration and deploy in the order migration first, edge/web second.
5. Land PR #15 once its thread finishes.
6. Decide on PR #1 and PR #9 leftovers; close if stale.
