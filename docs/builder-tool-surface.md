# Builder tool surface: lean, in each model family's native shape

Decision recorded 2026-10-17. Status: decided; implementation and measurement in progress (branch `lean-tools`).

## Decision

1. **Keep the builder's always-on tool set as small as possible.** About 4 tools: run commands, edit files, read/write where the family expects them, and view images. Everything else becomes either a command on the workspace VM plus one line of instruction, or a tool that appears only when it applies.
2. **Show each model family the tools it was trained on.** Names *and* argument shapes match the vendor's own harness. All families share one engine underneath: the same command runner, the same tolerant edit engine and the same limits. Only the thin layer that maps names and arguments differs.

## Why

- **The reference agents are lean.**
  - Codex: `exec_command`, `write_stdin`, `apply_patch`, `view_image`, `update_plan`.
  - Claude Code: `Bash`, `Read`, `Edit`, `Write`, with everything else loaded on demand.
  - Pi: `read`, `write`, `edit`, `bash`.
  - Our builder has ~13 always-on tools.
- **More tools didn't buy points.** mini-SWE-agent, with only bash, scored 65% on Terminal-Bench (Opus 5.5), above our 55% with more tools.
- **Models are post-trained inside their own vendor's harness.**
  - GPT models are trained to write `apply_patch` patches (`*** Begin Patch` format) and to drive commands as live sessions (`exec_command` + `write_stdin`).
  - Claude is trained on `Bash` plus exact-string `Edit` (`old_string` → `new_string`).
  - A single neutral design is a compromise for every family.
- **We build a harness for every model, not for one vendor.** So the shape adapts to the model, and the engine stays shared.

## Per-family surface

| Family | Commands | Edit | Other |
|---|---|---|---|
| GPT (OpenAI) | `exec_command` + `write_stdin` (session id for long or interactive commands) | `apply_patch` | `view_image` |
| Claude | `Bash` (waits, with a timeout; long jobs in the background) | `Edit` (old/new string), `Write`, `Read` | images through `Read` |
| Gemini | Gemini CLI shape (`run_shell_command`, `replace`, `write_file`, `read_file`); names to verify | | |
| Open models (Qwen, GLM, DeepSeek, Kimi…) | Claude shape by default; verify per model | | |

## What moves out of the tool list

| Old tool | Becomes |
|---|---|
| `check_deliverable` | VM command `ytimesy-check --files <paths> [--input <paths>] [--unprivileged] -- <command>` |
| `read_context_archive`, `search_context_history` | After compaction, the removed conversation is written to `~/.ytimesy/history/` and searched with `rg` |
| `read_environment_report` | `~/.ytimesy/environment.md` |
| `browser_open/_screenshot/_inspect/_execute` | VM command `ytimesy-browser open|screenshot|inspect|exec`; screenshots viewed with the image tool |
| `stop_command` | Folded into the family's command tools |

**These stay tools, because they need our server or the UI, and appear only when they apply:**
- MCP tools (credentials stay server-side),
- web search,
- plan proposals and secret requests (plan mode).

## Instructions (shape-neutral wording; tool names filled in per family)

> Your tools: <run tool> runs shell commands; <edit tool> changes files; <image tool> shows you an image. Everything else is a command in the workspace:
> - `ytimesy-check --files <delivered paths> -- <run command>`: when you deliver something another person or system will run on its own, run it once before finishing; it runs your deliverable from a clean copy. Fix what it reports.
> - Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.
> - `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.
> - `ytimesy-browser open|screenshot|inspect|exec` drives the desktop browser for visual checks.

## How we decide it worked

- **Setup:** a setting chooses current vs lean-native on the same deploy.
- **What we run:**
  - GPT on the native-vs-harness rig (Codex subscription),
  - free open models on the model smoke suite,
  - Claude when credits allow.
- **What we measure:** pass rate, time, steps and tokens.
- **Keep lean-native only if** pass rate holds and time or tokens drop.
- **Checked separately:**
  - the history files, once with a compaction-forcing task,
  - `ytimesy-browser`, once with a visual task.
