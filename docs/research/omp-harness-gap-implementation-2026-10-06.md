# Oh My Pi comparison follow-up

Worktree: `codex/omp-harness-gaps`, based on Cursor-gap commit `d998928`.
This work leaves the original and Cursor worktrees, servers and external systems
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
  filesystem transaction. Project checks remain required. File-move refactors
  and arbitrary code actions are not implemented.
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

Structural outlines currently support TypeScript/JavaScript syntax, not OMP's
full language catalog. Symbol refactors require a functioning configured server;
Python/Rust/Go still require guest server binaries. Other debugger runtimes,
file renames and a persistent native guest tool service remain separate scope.

## Checks

Full suite: 290 files passed, 1,513 tests passed, five existing skips.
Application and workflow TypeScript checks, production build, changed-file
Biome with warnings treated as errors, and `git diff --check` passed.
No live model/Freestyle run or OMP paired benchmark was performed.
