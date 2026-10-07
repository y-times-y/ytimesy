# Oh My Pi comparison follow-up

Worktree: `codex/omp-harness-gaps`, based on Cursor-gap commit `d998928`.
This work leaves the original and competitor worktrees, servers and external systems
untouched. No paid model calls, VMs, migrations or deployment are needed.

## Implemented

- `read_code`: parser-derived TS/JS/TSX/JSX outlines with declarations, class
  members, signatures and 1-based line spans. Bodies are omitted; statement
  spans and truncation are explicit. Exact line selections work on any bounded
  UTF-8 file, preserve CRLF and BOM, and optionally compare the outline's SHA-256.
  Four files share one guest execution. Unsupported outlines explicitly direct
  the agent to ordinary source reads. An outline is never complete-read evidence.
- `rename_symbol`: writable builders obtain a warm language-server rename and
  its source snapshots, validate UTF-16 positions, then apply via the existing
  source-hash-fenced guest editor. All source hashes preflight under its existing
  repository lock before writing starts. Durable tool receipts prevent blind
  replay. One to eight existing files are supported; resource operations,
  annotated edits, symlink targets, oversized or invalid responses fail closed.
  Filesystem failure during application can still leave partial edits; receipts
  identify completed, failed and unattempted files. This is not a multi-file
  filesystem transaction. Project checks remain required. This initial checkpoint was expanded below.
- `inspect_code_batch`: two to four independent same-language queries share
  one guest execution and one warm-server connection. This reduces VM round
  trips and client startup, while the language server retains its serialized
  request policy. It does not eliminate the hosted server/VM boundary or create
  a native embedded shell/search engine. Existing single queries still work.
- TypeScript language sessions disable the syntax-server fallback. A real cold
  fixture demonstrated that the default dynamic routing could initially return
  only the declaration and miss imports/references; semantic-only routing found
  all three references and produced the complete cross-file rename.
- Core discovery exposes structural reads; refactoring and batched LSP remain
  discoverable. The model guidance explains outline-to-source follow-ups and the
  new tools. Metrics distinguish these read/edit operations.

## Reuse

Existing TypeScript parser, pinned guest tooling, warm JSON-RPC servers, workspace
resolution, path boundaries, guest edit lock, stale-source protection and durable
command receipts are reused. Microsoft's maintained MIT-licensed
[`vscode-languageserver-textdocument` 1.0.15](https://github.com/microsoft/vscode-languageserver-node/tree/main/textDocument)
handles edit ordering and application. Product-specific code validates positions
instead of accepting the library's coordinate clamping, rejects unsupported
workspace edits, fences source snapshots and shapes bounded observations. No
custom parser or replacement agent runtime was added.

## Verification boundaries

Local process fixtures execute the actual TypeScript parser, TypeScript language
server, text-edit library, Git/Python editor and socket transport. The integration
fixture replaces only the cloud transport with local execution and already
installed dependencies. It proves batched call count and server reuse, cross-file
rename, receipt replay, stale-file preflight, CRLF, Unicode handling and read-only
exclusion. It does not prove Freestyle tool latency, live model tool selection,
production behavior or comparative coding quality/cost.

These were the initial checkpoint limits; the follow-up implementation below
adds broader outlines, setup, file moves, actions, guest persistence and DAP.

## Initial checkpoint checks

Full suite: 290 files passed, 1,513 tests passed, five existing skips.
Application and workflow TypeScript checks, production build, changed-file
Biome with warnings treated as errors, and `git diff --check` passed.
No live model/Freestyle run or OMP paired benchmark was performed.


## Follow-up implementation

`read_code` now uses pinned web-tree-sitter 0.25.10 and maintained Repomix WASM
artifacts 0.1.17 for Python, Rust, Go, C/C++, C#, Java, Ruby, PHP, Swift, Dart,
Solidity, CSS and Vue. TypeScript/JavaScript keep the existing compiler parser.
Large declarations omit bodies; use exact source ranges before edits. Six actual
language grammars are covered by integration tests. This is not a full syntax
catalog or proof every grammar handles every declaration.

`rename_file` requests the server's willRenameFiles edits, snapshots affected
sources and uses the existing edit lock/hash fences. It refuses overwrites,
symlink paths, missing parents and unsupported resource edits. The source moves
last; partial filesystem failures still require receipt inspection.
`apply_code_action` re-queries an action and checks source/resolved-edit identity
before application. Text-only workspace edits are supported; server commands
and resource operations remain rejected. Opaque server IDs are excluded from
identity because TypeScript changes them between identical requests.

The Freestyle adapter now starts an authenticated HTTPS guest capability service
once and reuses it for subsequent language/browser/debugger operations. Its
purpose is to remove repeated VM exec and guest client startup. The VM owns
processes and dependencies; admission and pause guards run on every invocation.
The endpoint uses a 256-bit private bearer token, rejects browser Origin headers,
uses bounded requests/results, and expires after five idle minutes. Uncertain
responses are never replayed automatically. Session path scoping and the native
runner's explicit transport exclusion preserve existing boundaries.

`prepare_code_tools` pins pyright 1.1.414, debugpy 1.8.20, gopls 0.21.0,
Delve 1.27.2 and checksum-verified rust-analyzer 2026-10-05. Go/Rust project
compilers and native debugger binaries are environment prerequisites; the tool
does not install system packages or modify project manifests. Existing utilities
and maintained parsers/protocol libraries were preferred. Product-specific code
handles source fences, session ownership, bounded results and lifecycle.

`debug_program` uses the standard DAP ProtocolClient from Microsoft's MIT-licensed
package, supporting Python/debugpy, Go/Delve, installed LLDB, DAP-capable GDB,
.NET/netcoredbg and repository-configured stdio adapters. It launches owned
programs, supports initial/replacement breakpoints, stack/scopes/variables,
continue/pause/step/stop, and rejects stale pause references. It does not attach
to unrelated processes or evaluate arbitrary expressions. Python is covered by
an actual debugpy fixture; other adapters require environment-specific live proof.

Tree-sitter is MIT licensed; Repomix's artifact package is Unlicense, and individual
upstream grammars retain their own licenses. Microsoft protocol/document packages
and pyright are MIT licensed. Exact dependency versions and lockfile are committed.

## Follow-up validation and evaluation boundary

Full local suite: 293 files, 1,517 passing tests and five skips. The new integration
fixtures exercise the actual persistent HTTP service, semantic TS server, file
move/import edits, organize-imports action, grammar outlines and Python debugger.
The Python fixture is conditional on an installed ignored debugpy runtime.
Production build and application/workflow type checks are separate checks.

`scripts/evaluate-omp-builder.ts` compares frozen source at d998928 with this
implementation through each revision's existing builder model loop and actual VM
tools. It is a development probe, not the full production queue evaluator. It
excludes leader delegation, review and durable database tool journals. It uses
one synthetic pricing/refactor task pair, the same model/reasoning and clean Git
fixture, and a protected networkless Docker verifier. The verifier checks hidden
arithmetic cases, import consolidation, helper preservation, scope, and typechecks.
The operator proves that the original fixture fails and a known correct patch
passes before any model requests. The hidden verifier stays outside coding VMs.

Approval: up to $5 VM spend and 20 actual inference invocations, including retries.
One disposable VM has a 30-minute provider lifetime and conservative resource
ceiling; each arm permits ten requests, no unmetered native compaction. Private
attempt counters, traces and patches are ignored. Cleanup deletes the owned VM.
Results belong in the separate performance report. A single pair cannot establish
general coding superiority or performance parity with OMP/competitor.


## Final live evidence and diagnostic wait correction

The live builder comparison and subsequent fix are documented in
[the end-to-end report](omp-harness-end-to-end-2026-10-06.md). Both model-generated
code patches passed the unchanged protected verifier after byte-verified setup
artifact normalization. The initial expanded arm was slower because optional
push diagnostics blocked edit receipts. Edit feedback now polls immediately;
explicit diagnostics retain their bounded wait. A delayed real-server regression
fixture passed, and the same actual VM refactor/check/grade sequence improved
from 53.384 seconds to 5.156 seconds with both grades passing. This retest used no
model requests; it is not another paired model coding result. Eighteen actual
model calls were consumed, and all six created VMs were confirmed deleted.
