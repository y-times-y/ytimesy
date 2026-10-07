# OMP gap completion and end-to-end evidence

The requested tool gaps are implemented in `codex/omp-harness-gaps`: persistent
VM capability transport, maintained multi-language outlines, source-fenced file
moves and text-only code actions, pinned Python/Go/Rust server preparation, and
owned standard DAP debugging. Real VM integration passed. Testing also exposed
an edit-latency regression, which is fixed and verified below.

## Actual model coding pair

The existing builder model loop ran the same untouched TypeScript/Python pricing
fixture on baseline `d998928` and expanded treatment `c28aaa2`, using the same
connected Codex subscription model, `gpt-6.1-sol`, low reasoning, and ten-request
ceiling per arm. Both reached a final response. Credentials stayed on the host.
The original protected verifier was held outside the coding VM and ran afterward
in the pinned, networkless Docker grader. It checks arithmetic edge cases,
function/file renames, import consolidation, unchanged helper bodies and a strict
TypeScript check. Its original buggy fixture failed and known correct patch
passed before any model requests.

| Observation | Baseline | Expanded, before wait fix |
| --- | ---: | ---: |
| Builder + protected grading | 39.149 s | 89.971 s |
| Actual model requests, retries included | 8 | 10 |
| Reported input tokens, summed requests | 115,216 | 237,392 |
| Reported cached input tokens | 74,112 | 179,200 |
| Output tokens | 867 | 700 |
| Model duration, summed | 32.756 s | 34.105 s |
| Tool duration, summed | 5.628 s | 55.110 s |
| Original raw scope grade | Failed: setup artifacts | Failed: setup artifacts |
| Code-only protected grade | Passed | Passed |

The raw scope failures were evaluator defects: setup injected a `node_modules`
symlink and macOS `._.git` metadata. Neither existed in the frozen task commit.
The dependency link's Git blob identity was verified against the configured
installation path; metadata identity was verified against the exact uploaded
operator-side archive. Only those two exact artifacts were removed from the
patches before repeating the unchanged protected grader. Raw results are retained.
No model output or source changes were filtered. The normalizer refuses different
artifact bytes. Future runs suppress archive metadata, exclude injected artifacts
locally in Git, and require a clean checkout before inference.

The expanded model chose actual symbol/file refactors. Optional diagnostic waits
cost 32.328 seconds on the file move and 16.014 seconds on the later patch. The
baseline used shell moves and direct patches, so it did not activate that wait
path. This sample showed a regression, not an overall coding speedup.

## Fix and real VM retest

Language diagnostics are asynchronous observations, and a server need not publish
a fresh notification after every edit. Edit receipts now poll available
observations without waiting for a push. Explicit `inspect_code` diagnostics
retain the bounded 15-second wait. Unobserved diagnostics remain marked unobserved;
project checks remain required. The server protocol identity was advanced so
existing processes cannot silently retain the previous wait behavior.

A regression test proxies a real TypeScript server and delays its diagnostic
notifications by three seconds. Feedback polling returns promptly; explicit
inspection still receives the diagnostic. It passed.

The same scripted production-tool pipeline then ran on a real disposable VM
against frozen `c28aaa2` and fixed `e6313d4`. It performed symbol rename, file move,
organize-imports, both arithmetic fixes, public project checks and the original
protected grade. Initial server warmup is outside the pipeline wall time.

| Operation | Before wait fix | After wait fix |
| --- | ---: | ---: |
| Complete refactor/check/grade pipeline | 53.384 s | 5.156 s |
| Symbol rename | 2.737 s | 0.390 s |
| File move with import updates | 31.029 s | 0.316 s |
| Apply import action | 15.306 s | 0.166 s |
| TypeScript arithmetic edit | 0.694 s | 0.178 s |
| Python arithmetic edit | 0.146 s | 0.133 s |
| Public checks | 1.472 s | 1.788 s |
| Protected grade | Passed | Passed |

The measured pipeline was **90.3% faster**, about **10.4×**. This establishes the
specific wait removal, not a new model-coding success or token-efficiency result.
The final implementation has not received another complete paired model coding
trial. Eighteen of the twenty approved model requests were used; two remain,
which is insufficient to repeat the full comparison under the same budget.

## Live integration, safety and budget

Real VM checks passed for pinned Python preparation, persistent guest service and
warm LSP reuse, parser outlines, file-move import updates, organize-imports and
Python DAP launch, breakpoint, locals, step and stale-reference rejection. No
model requests were used for those checks or the diagnostic-wait retest. Local
integration also covers actual Python/Rust/Go/Java/C++/Ruby grammars. Installed
Go/Rust project compilers and LLDB/GDB/.NET/Go debugger environments still need
their own live proofs; generic DAP support is not proof of every adapter.

Six disposable VMs were created across setup repairs and completed experiments;
all six were confirmed absent through fresh provider reads. No snapshots were
created. Five VMs had a maximum 30-minute lifetime and one had 15 minutes, with a
4-vCPU/8-GiB/32-GiB ceiling; observed VMs used 2 vCPU/4 GiB/16 GiB. The conservative
compute/storage lifetime ceiling is $0.77 total, plus a combined $1 transfer
reserve, within the approved $5. This is a pricing estimate, not an invoice audit.
Rates came from [Freestyle pricing](https://www.freestyle.sh/pricing).

Private counters, traces, raw/normalized patches and verifier files are ignored.
Sanitized observations are in the adjacent JSON. The tests use the actual builder
loop and tools but exclude the deployed production queue, leader delegation,
review/integration and durable database tool receipts. One synthetic task pair,
sequential order and a shared VM do not establish general superiority, complete
OMP/competitor parity, or production behavior.
