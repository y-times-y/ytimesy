# False GitHub credit: local rehearsal, not authorization to publish

Snapshot: November 24, 2026 UTC, `y-times-y/ytimesy` main `dd7bbb67834ce2fdc30331aac5a0c49eef931fcf`. Public GitHub reports 17 heads, 10 open PRs, no tags or releases, and zero forks; the Git server advertises 22 PR refs. Scanning the union of these refs covered 4,228 distinct commits. This cannot inspect unadvertised objects, external clones or historical mirrors.

GitHub's commit API resolves both author and committer of these five commits to user `ytimesy` (120704583); the live Contributors API assigns that account five contributions, and the public HTML for `b180617b` links its attribution to `/ytimesy`. Each target already has the canonical managed-bot trailer, and the prior identity audit independently flags the five. The live commit API for the preventive fix at `dd7bbb67` resolves both fields to `ytimesy-agent[bot]` (328807657). No other raw header or commit message, including trailers, used this exact stranger email or its ID-prefixed form in the advertised history. This is not a blanket correction of the earlier 59 heuristic audit candidates.

| Old commit | Repaired commit |
|---|---|
| `871a50eee64d5d62f1f1a76eb25e0c2a583404cd` | `4a92785e359980d90dd014e14b8ba7f110e19828` |
| `17e20f9fa382b8a1ebc3cb236fa97d96e834a228` | `4ea8d3b1ca09338d72c4ec103344f7c2f398e5a8` |
| `d9e85b47b6bb7de15cb63efd349088f2e8e032df` | `9b3178a6d9fadc06092ab7d1c7493f82a0a3ac32` |
| `e4419f0e910160e1610fafa64c66a66742ebb2b6` | `52e10bdc95ac2a14a82ec8ef7cfbc15c187de9f1` |
| `b180617bba3ab62f13efd7910703880959311ab2` | `f1227ef5bd2afd9855cb3974624d7e813f5ee65b` |

| Branch | Expected old tip (lease) | Candidate tip | Changed reachable commits |
|---|---|---|---:|
| `main` | `dd7bbb67834ce2fdc30331aac5a0c49eef931fcf` | `13d779da027e744d3ebc0f91c502448b4a134f31` | 16 |
| `add-gemini-neon` | `f4531ac56157ef46f5cd8d27ae49e7ae34d8dacc` | `5b1e014183551f68554f67b864ff0c2009944256` | 6 |
| `ytimesy/make-harness-and-codex-da9e18` | `2e581df3f980ef10bb23bd562afb2de1ce80a708` | `dba5b792a5bc4fe33b4163a39b9017be4f9fcbb3` | 7 |
| `ytimesy/make-y-super-agent-easy-d4f2ec` | `b180617bba3ab62f13efd7910703880959311ab2` | `f1227ef5bd2afd9855cb3974624d7e813f5ee65b` | 8 |
| `ytimesy/thread-to-thread-32f9e2` | `5a28481f59b45f8426bed95141a0507e634b2561` | `824368509e20227450442b305a01f6b0c8a43f09` | 15 |

There are 23 distinct changed objects: five identity edits and 18 descendants, of which three are GitHub-generated test merges (`#6`, `#9`, `#10`). Those three currently have verified GitHub signatures, which cannot survive changing the parents; their unsigned local analogs are for analysis only. No writable branch loses a signature. GitHub owns and regenerates open PR merge refs; never push the local analogs. Open PRs #6 and #10 have changed head ancestry; #9's head stays unchanged but its synthetic merge is affected. Closed PR #11 still references an original target via its read-only head. All 10 open PR three-dot patches were byte-identical in the full rehearsal; main-only changed the patches for #6 and #10. Existing commit URLs, reviews, comments, checks and mergeability can still be affected after publication; Git patch equivalence does not verify hosted behavior.

## Reproduce locally

From the checkout root, with Python 3 and Git:

```sh
python3 docs/maintenance/rehearse-false-credit.py /path/to/new/private-directory
```

The program fetches into a new bare repo with no push remote. It writes `original.bundle`, `candidate.bundle`, `snapshot`, `commit-map.tsv`, and `ref-map.tsv`. It refuses unexpected matching identities, false-email message lines, tags and signed descendants rather than silently broadening the reviewed scope. Expected output at the pinned snapshot: `4228 inspected, 23 changed, 3 signatures removed`. No Git identity is configured, no existing checkout is rewritten, and the program has no push command. Keep both bundles and SHA maps privately outside the worktree, checksum and restore-test them before any migration. Never publish the backup or the PR analysis refs.

## Decision and migration

- Git `.mailmap` can correct display in consumers that honor it (such as Git log); it does not change commit objects and there is no documented GitHub `.mailmap` remedy for commit-account linkage or contributor credit. A normal follow-up commit or the already-shipped guard cannot remove old credit. Do not change anyone's GitHub email or attribute other commits by guesswork.
- The smallest ref scope that removes the bad objects from **current writable branch history** is the five branches above, in one update. Main-only is narrower but leaves four branches pointing to bad objects and worsens two PR comparisons. Neither scope guarantees that the old hashes, closed PR refs, cached views or external copies disappear. GitHub's documented cached-view/PR dereferencing process is for sensitive data, not a supported purge for false attribution. Asking Support specifically about attribution is a separate action; no commitment that they can change it and no ticket submitted.
- Require explicit owner approval of the five named force updates, the old/new SHA map and accepted PR/old-SHA impact. Freeze branch landing and coordinate with build-20 and branch owners; verify protections, rulesets, app permissions and automatic deployment triggers before any push. The public active-rules endpoint showed none for main, but classic protection was not readable unauthenticated. If any expected tip, affected-ref scope, identity mapping, signature status or deploy policy changes, stop and refresh the rehearsal and approval. Do not disable protections without separate authorization.
- With approval, stage only the five candidate heads; use an atomic push with a separate `--force-with-lease=refs/heads/<branch>:<full-old-tip>` for each head and explicit refspecs, no mirror, no tags, no PR refs and no deletions. If the server rejects atomic push or any lease, stop rather than falling back to partial or unconditional force. A local bare-repo test rejected the entire batch with one stale lease, then accepted exactly the five branches with the correct leases.
- After publication, re-fetch, verify the five new tips, GitHub commit mappings and contributor credit, allow for delayed GitHub statistics, and check PR heads, diffs, generated merge refs and old URLs. Tell collaborators to fetch and migrate their local branches from the old base without re-merging the old history; preserve their unpublished work first. Rollback would also require approval and leases against the new tips, and could restore false attribution. Do not deploy solely for the history migration; build-20's code tree remains unchanged.

Primary sources: GitHub Docs, *Email addresses*, *Creating a commit with multiple authors*, and *Removing sensitive data from a repository*; Git documentation, `gitmailmap` and `git-push`.
