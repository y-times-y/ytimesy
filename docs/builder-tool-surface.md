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

Researched 2026-10-17 from vendor source and docs (primary sources unless noted).

| Shape | Models | Tools (names and argument shapes) |
|---|---|---|
| **Codex** | GPT-6.1 Sol, GPT-6 Luna, GPT-6 Astra | `exec_command{cmd, workdir, tty, yield_time_ms, max_output_tokens}` + `write_stdin{session_id, chars, yield_time_ms}` (session shell); `apply_patch` as a **freeform tool** with a grammar on the Responses API (JSON `{input}` fallback elsewhere); `update_plan`; `view_image` |
| **Claude Code** | Claude Opus/Sonnet/Haiku 5.5, Fable 5.1; Kimi K3 (Kimi Code copies these tools); Grok 4.7/4.6 (Grok Build uses these names; arguments unpublished); DeepSeek V4 / V4.1 and GLM 5.3 (vendors route coding through Claude Code; secondary sources); Muse (low-confidence guess) | `Bash{command, timeout, run_in_background}`, `Read`, `Write`, `Edit{file_path, old_string, new_string, replace_all}`, `Glob`, `Grep` |
| **Gemini CLI** | Gemini 4 Argon, 3.8 Flash, 3.7 Flash; Qwen3.8 Max (Qwen Code is a Gemini CLI fork) | `run_shell_command{command, dir_path, is_background}`, `read_file{file_path, start_line, end_line}`, `write_file`, `replace{file_path, old_string, new_string, allow_multiple}` (Qwen: `edit` with `replace_all`), `glob`, `grep_search` |

No model in the selector names the SWE-agent shape as its native harness.

**Engine requirements, whatever the shape:**
- **Pass reasoning back unchanged in tool loops.** Anthropic, Gemini, DeepSeek, GLM and Kimi all require it; DeepSeek returns a hard 400 without `reasoning_content`.
- **Accept Codex `apply_patch` as freeform input.**

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
> - `ytimesy-check --files <delivered paths> [--input <paths they supply>] [--unprivileged] -- <run command>`: when you deliver something another person or system will run on its own (a script, program, service, package or output files read elsewhere), run it once before finishing with what they receive and the documented command (--unprivileged when the task mentions another user or dropped privileges); it runs your deliverable from a clean copy. Fix what it reports. Skip it for edits to an existing project whose own tests you ran.
> - Parts of this conversation removed to save space are saved in `~/.ytimesy/history/`. Search there when you need exact earlier details.
> - `~/.ytimesy/environment.md` (if present) describes how this workspace was prepared.
> - `ytimesy-browser open|screenshot|inspect|exec` drives the desktop browser for visual checks.

**Behavioural guidance is kept.** The lean surfaces get v13-shell's behavioural lines as profile `v13-lean` (`harnessModelToolInstructions` in `src/domain/harness-model-profile.ts`): fix first, map requirements to checks, resolve ambiguity yourself, deliverables work in a fresh environment, implement literally, distrust "impossible", generalize instead of fitting the examples, in the lean tools' names. Only the lines about removed tools (`continue_command`/`stop_command`, the context archive tools) are dropped or pointed at their workspace replacements, so a comparison measures the tool surface, not prompt removal.

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

## Implementation (branch `lean-tools`)

- **Wiring point:** `builderToolSurface({ variant, modelId, tools, lean })` in `src/server/services/builder-shell-surface.ts`, called once in `api-turn.ts` where `builderShellTools` was. The variant is the turn's development harness variant `toolSurface` (`current` | `lean-native` | `lean-pi`, `src/domain/harness-variant.ts`; docs/parallel-evals.md): a development eval user picks it per run, everyone else and production get `current`. The returned `lean` object also supplies the history writer, the background-command reader text and the instruction shape.
- **Family detection:** `leanToolShape(variant, modelId)` in `src/domain/harness-model-profile.ts` (GPT → Codex; Gemini → Gemini CLI; Qwen → Qwen Code; everything else → Claude Code; `lean-pi` → Pi for all).
- **Engine:** `src/server/services/lean-tools.ts` (commands through `execute_command`/`continue_command`/`stop_command`; one file reader/writer; output limit in `lean-output.ts`), `lean-edit.ts` (exact, then Pi-style fuzzy match that rewrites only the matched region).
- **Workspace commands:** `lean-helpers.ts` installs `ytimesy-check`, `ytimesy-browser`, `ytimesy-job` (status/wait/stop for background commands) and `~/.ytimesy/environment.md` the first time a lean tool touches the VM; compaction writes `~/.ytimesy/history/<time>-<archive>.md`.
- **Measure:** `node --import tsx scripts/builder-context-breakdown.ts --surfaces`.
