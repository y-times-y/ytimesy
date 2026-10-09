# Fixes following the builder performance regression

The preceding [live pilot](builder-core-performance-pilot-2026-10-08.md) found
specialist refactor turns, extra reads, inflated move diffs and a missing final
answer at the unchanged ten-request limit. Timing attribution showed model work
at 30.2 versus 31.7 seconds, but tool work at 5.7 versus 19.1 seconds. The
8.8-second semantic rename and 7.1-second diff call dominated the observed tool
delay. Their internal timing components were not recorded; no specific cause
for the slow diff RPC is established.

## Changes

- Model guidance now asks for the least expensive safe workflow: batch known
  changes, using semantic refactors when uncertainty warrants them rather than
  preferring them on every small task. Exact source reads, stale-source fences
  and final required verification remain mandatory.
- `compose_tools` accepts already-authorized `rename_symbol`, `rename_file` and
  `apply_patches`. Their existing executors, edit locks, schema checks and journal
  identities remain intact. Explicit serial dependencies are required, and
  failures or deferred instructions block successors. Composition does not make
  logically dependent mutations parallel or permit skipping an observation
  needed to choose a subsequent edit.
- Change inspection copies the Git index into a private temporary directory,
  marks safe untracked files intent-to-add there, and asks Git to detect renames.
  Staged evidence is shown separately. The real index is not updated. Ignored
  files and symlink targets remain excluded; pathspecs are literal. External
  converters, configured clean/process filters, fsmonitor and hooks are disabled
  for inspection. No custom similarity algorithm or permanent indexing service
  was added.

## Verification boundaries

Real local Git regression fixtures cover compact changed renames, staged plus
unstaged work, ignored files, symlink targets, binary additions, literal path
scopes, unborn repositories, configured filters and exact real-index preservation.
The 727-line rename fixture requires the full result to be below 1,000 characters
while retaining the changed line and rename identity.

Composition fixtures cover ordered specialist mutations and stable wrapper
identities, in addition to existing authorization, validation, failed-dependency
and cancellation tests. Profile tests retain bounded instructions and verification
requirements across provider families.

Full local suite: 315 files passed, one skipped; 1,657 tests passed, seven skipped.
TypeScript, production build, changed-file Biome and `git diff --check` passed.

These are implementation and local mechanism proofs. No fresh live coding pilot
was run for these fixes; specialist cold-start latency, the slow diff RPC and
model adoption of the guidance remain unmeasured. Neither the evaluation request
limit nor its protected grader was relaxed. No native-Codex parity claim is made.
