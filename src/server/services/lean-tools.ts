import { randomUUID } from "node:crypto";
import { detectMediaType } from "@ai-sdk/provider-utils";
import { type Tool, type ToolSet, tool } from "ai";
import { z } from "zod";
import type { LeanToolShape } from "#/domain/harness-model-profile";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { agentOutputDirectory } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import { COMMAND_WAIT_MAX_SECONDS } from "./command-wait";
import { journaledToolOperation } from "./journaled-tool-operation";
import {
	applyLeanEdit,
	applyLeanEdits,
	LeanEditError,
	type LeanEditNames,
} from "./lean-edit";
import { ensureLeanHelpers } from "./lean-helpers";
import {
	commandTruncationNote,
	LEAN_MAX_BYTES,
	LEAN_MAX_LINES,
	truncateHead,
	truncateTail,
} from "./lean-output";
import { toolRequestFingerprint } from "./tool-execution-identity";

/**
 * The lean builder surfaces (docs/builder-tool-surface.md): each model family
 * sees the tool names and argument shapes of its own vendor harness (or Pi's
 * neutral four), over one shared engine. Commands go through the runtime's
 * execute/continue/stop tools (same runner, limits, journal and background
 * tracking); edits through one exact-then-fuzzy matcher; every output through
 * one limit (2000 lines / 50 KB, head for reads, tail for commands, with the
 * full command output kept in a file).
 */

export type LeanSurfaceContext = {
	workspace: () => Promise<AgentToolWorkspace>;
	sessionId: string;
	turnId: string;
	toolCallPrefix?: string;
	signal: AbortSignal;
	/** Runs a write once per tool call; a retried step gets the recorded outcome. Defaults to the durable journal. */
	once?: (
		requestId: string,
		fingerprint: string,
		run: () => Promise<unknown>,
	) => Promise<unknown>;
	/** Memoizes helper installation for the turn (api-turn passes turnMemo). */
	memo?: <T>(key: string, load: () => Promise<T>) => Promise<T>;
	/** Installs the workspace commands; defaults to ensureLeanHelpers. */
	installHelpers?: (workspace: AgentToolWorkspace) => Promise<void>;
};

type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];
type CommandPage = {
	id: string;
	status: number | "running" | "interrupted";
	stopped?: "timeout" | "output_limit" | null;
	stdout?: string;
	start?: number;
	nextStart?: number | null;
	note?: string;
};

export type LeanCommandResult = {
	/** The runtime's command id; background tracking reads `id` and `status: "running"`. */
	id: string;
	status: number | "running" | "interrupted";
	stopped?: "timeout" | "output_limit" | null;
	command: string;
	output: string;
	outputPath: string;
	truncationNote?: string;
	wallSeconds: number;
	note?: string;
};

type FileRead =
	| { path: string; missing: true }
	| { path: string; directory: true; entries: string[] }
	| { path: string; binary: true; bytes: number }
	| { path: string; error: string }
	| {
			path: string;
			image: string;
			base64: string;
			bytes: number;
	  }
	| {
			path: string;
			lines: string[];
			totalLines: number;
			startLine: number;
			cut: boolean;
	  };

const READ_SCRIPT = String.raw`import base64, hashlib, json, os, sys
path, cwd, mode = os.path.expanduser(sys.argv[1]), sys.argv[2], sys.argv[3]
offset, limit, max_bytes, max_line = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
if not os.path.isabs(path): path = os.path.join(cwd, path)
path = os.path.normpath(path)
def out(value):
    print(json.dumps(dict(value, path=path), ensure_ascii=False)); sys.exit(0)
if not os.path.exists(path): out({'missing': True})
if os.path.isdir(path): out({'directory': True, 'entries': sorted(os.listdir(path))[:200]})
size = os.path.getsize(path)
with open(path, 'rb') as handle: head = handle.read(8192)
image = 'image/png' if head.startswith(b'\x89PNG') else 'image/jpeg' if head.startswith(b'\xff\xd8\xff') else 'image/gif' if head[:6] in (b'GIF87a', b'GIF89a') else 'image/webp' if head[:4] == b'RIFF' and head[8:12] == b'WEBP' else None
if mode == 'full':
    if size > 20000000: out({'error': 'File is larger than 20 MB'})
    raw = open(path, 'rb').read()
    try: content = raw.decode('utf-8')
    except UnicodeDecodeError: out({'error': 'File is not UTF-8 text'})
    out({'content': content, 'sha256': hashlib.sha256(raw).hexdigest()})
if image:
    if size > 5000000: out({'error': 'Image is larger than 5 MB'})
    out({'image': image, 'base64': base64.b64encode(open(path, 'rb').read()).decode(), 'bytes': size})
if b'\0' in head: out({'binary': True, 'bytes': size})
lines, used, total, cut = [], 0, 0, False
with open(path, encoding='utf-8', errors='replace', newline='') as handle:
    for line in handle:
        total += 1
        if total < offset or cut: continue
        if len(lines) >= limit: cut = True; continue
        text = line.rstrip('\r\n')
        if max_line and len(text) > max_line: text = text[:max_line] + '... [line truncated]'
        size_of = len(text.encode('utf-8')) + 1
        if used + size_of > max_bytes and lines: cut = True; continue
        lines.append(text); used += size_of
out({'lines': lines, 'totalLines': total, 'startLine': offset, 'cut': cut})`;

const WRITE_SCRIPT = String.raw`import hashlib, json, os, sys, tempfile
payload = sys.argv[1]
with open(payload, encoding='utf-8') as handle: spec = json.load(handle)
os.remove(payload)
path = os.path.expanduser(spec['path'])
if not os.path.isabs(path): path = os.path.join(spec['cwd'], path)
path = os.path.normpath(path)
if os.path.islink(path): path = os.path.realpath(path)
def out(value):
    print(json.dumps(dict(value, path=path))); sys.exit(0)
if os.path.isdir(path): out({'error': 'is a directory'})
existed = os.path.exists(path)
if 'expectedSha256' in spec:
    current = hashlib.sha256(open(path, 'rb').read()).hexdigest() if existed else None
    if current != spec['expectedSha256']: out({'error': 'stale'})
data = spec['content'].encode('utf-8')
directory = os.path.dirname(path) or '.'
os.makedirs(directory, exist_ok=True)
mode = os.stat(path).st_mode & 0o7777 if existed else 0o644
descriptor, temporary = tempfile.mkstemp(dir=directory, prefix='.ytimesy-write-')
with os.fdopen(descriptor, 'wb') as handle: handle.write(data)
os.chmod(temporary, mode)
os.replace(temporary, path)
out({'created': not existed, 'bytes': len(data), 'lines': data.count(b'\n') + (0 if data.endswith(b'\n') or not data else 1)})`;

const TAIL_SCRIPT = String.raw`import json, sys
path, start, max_chars = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    with open(path, encoding='utf-8', errors='replace') as handle: text = handle.read()
except FileNotFoundError:
    text = ''
part = text[start:]
lines = part.count('\n') + (1 if part and not part.endswith('\n') else 0)
print(json.dumps({'text': part[-max_chars:], 'cut': len(part) > max_chars, 'lines': lines, 'end': len(text)}, ensure_ascii=False))`;

/** Where each lean command's output continues from, for Codex's write_stdin (output since the last read). */
const commandCursors = new Map<string, number>();
const rememberCursor = (id: string, end: number | undefined) => {
	if (end === undefined) commandCursors.delete(id);
	else {
		commandCursors.delete(id);
		commandCursors.set(id, end);
		if (commandCursors.size > 500)
			commandCursors.delete(commandCursors.keys().next().value as string);
	}
};

/** The shared engine: one command runner, one file reader/writer, one edit matcher, one output limit. */
export function leanEngine(base: ToolSet, context: LeanSurfaceContext) {
	const { signal } = context;
	const outputDirectory = agentOutputDirectory(context.sessionId);
	const outputPath = (id: string) => `${outputDirectory}/${id}.stdout`;
	let helpers: Promise<void> | undefined;
	/** The workspace, with the helper commands installed (best effort: a failure only costs the helpers). */
	const ready = async () => {
		signal.throwIfAborted();
		const workspace = await context.workspace();
		const install = () =>
			context.installHelpers
				? context.installHelpers(workspace)
				: ensureLeanHelpers(workspace, context.sessionId);
		helpers ??= (
			context.memo
				? context.memo(`lean-helpers:${workspace.vm}`, install)
				: install()
		).catch((error: unknown) => {
			console.warn("Lean workspace commands were not installed.", error);
		});
		await helpers;
		return workspace;
	};
	const once = (
		name: string,
		args: unknown,
		options: ExecuteOptions,
		run: () => Promise<unknown>,
	) => {
		const requestId = `${context.turnId}:${context.toolCallPrefix ?? ""}${options.toolCallId}`;
		const fingerprint = toolRequestFingerprint(name, args);
		return context.once
			? context.once(requestId, fingerprint, run)
			: journaledToolOperation(
					{ sessionId: context.sessionId, requestId, fingerprint, signal },
					run,
				);
	};
	const call = async (name: string, args: unknown, options: ExecuteOptions) => {
		const execute = base[name]?.execute;
		if (!execute)
			throw new Error(`The command runner (${name}) is unavailable.`);
		return (await execute(args as never, options)) as CommandPage;
	};

	/** Shows a page's output (or the file's tail from `from`) within the limit, tail kept. */
	async function shown(
		workspace: AgentToolWorkspace,
		id: string,
		page: CommandPage,
		from: number,
		maxBytes: number,
	) {
		const text = page.stdout ?? "";
		const complete =
			page.start === from &&
			(page.status === "running"
				? text.length < 32_000
				: page.nextStart === null || page.nextStart === undefined);
		if (complete) {
			const truncation = truncateTail(text, { maxBytes });
			return {
				output: truncation.content,
				end:
					page.status === "running" ? (page.nextStart ?? undefined) : undefined,
				note: truncation.truncated
					? commandTruncationNote(truncation, outputPath(id))
					: undefined,
			};
		}
		const result = await workspace.machines.exec(
			workspace.vm,
			`python3 -c ${quote(TAIL_SCRIPT)} ${quote(outputPath(id))} ${from} ${maxBytes + 1}`,
			30_000,
		);
		if (result.exitCode)
			return {
				output: text,
				end: page.nextStart ?? undefined,
				note: `[Output may be incomplete. Full output: ${outputPath(id)}]`,
			};
		const tail = JSON.parse(result.stdout) as {
			text: string;
			cut: boolean;
			lines: number;
			end: number;
		};
		const truncation = truncateTail(tail.text, { maxBytes });
		const shownLines = truncation.lastLine - truncation.firstLine + 1;
		return {
			output: truncation.content,
			end: page.status === "running" ? tail.end : undefined,
			note:
				truncation.truncated || tail.cut
					? commandTruncationNote(
							{
								firstLine: tail.lines - shownLines + 1,
								lastLine: tail.lines,
								totalLines: tail.lines,
							},
							outputPath(id),
						)
					: undefined,
		};
	}

	async function settle(
		workspace: AgentToolWorkspace,
		command: string,
		page: CommandPage,
		from: number,
		started: number,
		maxBytes = LEAN_MAX_BYTES,
	): Promise<LeanCommandResult> {
		const view = await shown(workspace, page.id, page, from, maxBytes);
		rememberCursor(page.id, view.end);
		return {
			id: page.id,
			status: page.status,
			...(page.stopped ? { stopped: page.stopped } : {}),
			command,
			output: view.output,
			outputPath: outputPath(page.id),
			...(view.note ? { truncationNote: view.note } : {}),
			wallSeconds: Math.round((Date.now() - started) / 100) / 10,
			...(page.note ? { note: page.note } : {}),
		};
	}

	return {
		ready,
		outputPath,
		/**
		 * Runs a command. It returns when the command exits, or once `yieldSeconds`
		 * pass while it still runs; `waitSeconds` then keeps waiting for the exit
		 * (bounded by the step's deadline). A command still running returns its id.
		 */
		async run(
			input: {
				command: string;
				workdir?: string;
				maxSeconds: number;
				yieldSeconds: number;
				waitSeconds?: number;
				maxBytes?: number;
			},
			options: ExecuteOptions,
		): Promise<LeanCommandResult> {
			const workspace = await ready();
			const started = Date.now();
			const command = input.workdir
				? `cd ${quote(input.workdir)} && ${input.command}`
				: input.command;
			let page = await call(
				"execute_command",
				{
					command,
					maxSeconds: Math.min(600, Math.max(30, Math.ceil(input.maxSeconds))),
					yieldSeconds: Math.min(
						30,
						Math.max(0, Math.round(input.yieldSeconds)),
					),
				},
				options,
			);
			if (page.status === "running" && input.waitSeconds)
				page = {
					...(await call(
						"continue_command",
						{
							id: page.id,
							start: 0,
							seconds: Math.min(
								COMMAND_WAIT_MAX_SECONDS,
								Math.ceil(input.waitSeconds),
							),
						},
						options,
					)),
					id: page.id,
				};
			return settle(workspace, input.command, page, 0, started, input.maxBytes);
		},
		/** Writes to a running command and/or waits; returns output since the last read. Ctrl-C stops it. */
		async write(
			input: {
				id: string;
				chars: string;
				yieldSeconds?: number;
				maxBytes?: number;
			},
			options: ExecuteOptions,
		): Promise<LeanCommandResult> {
			const workspace = await ready();
			const started = Date.now();
			if (input.chars.includes("\u0003")) {
				await call("stop_command", { id: input.id }, options);
				return settle(
					workspace,
					"",
					{ id: input.id, status: 130, start: -1, stdout: "" },
					commandCursors.get(input.id) ?? 0,
					started,
					input.maxBytes,
				);
			}
			const eof = input.chars.includes("\u0004");
			const chars = input.chars.replaceAll("\u0004", "");
			const from = commandCursors.get(input.id) ?? 0;
			const page = await call(
				"continue_command",
				{
					id: input.id,
					...(chars ? { chars } : {}),
					...(eof ? { eof } : {}),
					start: from,
					...(input.yieldSeconds !== undefined
						? {
								seconds: Math.min(
									COMMAND_WAIT_MAX_SECONDS,
									Math.max(0, Math.ceil(input.yieldSeconds)),
								),
							}
						: {}),
				},
				options,
			);
			return settle(
				workspace,
				"",
				{ ...page, id: input.id },
				from,
				started,
				input.maxBytes,
			);
		},
		async readFile(
			path: string,
			range: { offset: number; limit: number; maxLineCharacters?: number },
		): Promise<FileRead> {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(READ_SCRIPT)} ${quote(path)} ${quote(workspace.cwd)} page ${Math.max(1, range.offset)} ${Math.max(1, range.limit)} ${LEAN_MAX_BYTES} ${range.maxLineCharacters ?? 0}`,
				30_000,
			);
			if (result.exitCode || result.stdout.length > 8_000_000)
				throw new Error(`Could not read ${path}.`);
			return JSON.parse(result.stdout) as FileRead;
		},
		/** The whole UTF-8 file and its hash, or null when it does not exist. */
		async readWhole(path: string) {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(READ_SCRIPT)} ${quote(path)} ${quote(workspace.cwd)} full 1 1 0 0`,
				30_000,
			);
			if (result.exitCode) throw new Error(`Could not read ${path}.`);
			const read = JSON.parse(result.stdout) as {
				path: string;
				missing?: true;
				directory?: true;
				error?: string;
				content?: string;
				sha256?: string;
			};
			if (read.directory) throw new LeanEditError(`${path} is a directory.`);
			if (read.error) throw new LeanEditError(`${path}: ${read.error}.`);
			return read.missing
				? { path: read.path, content: null, sha256: null }
				: {
						path: read.path,
						content: read.content as string,
						sha256: read.sha256 as string,
					};
		},
		/** Writes a whole file; with `expectedSha256` (null: must not exist) it refuses a file that changed. */
		async writeFile(
			path: string,
			content: string,
			expectedSha256?: string | null,
		) {
			const workspace = await ready();
			const payload = `/tmp/ytimesy-lean-write-${randomUUID()}.json`;
			await workspace.machines.writeTextFile(
				workspace.vm,
				payload,
				JSON.stringify({
					path,
					cwd: workspace.cwd,
					content,
					...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
				}),
			);
			const result = await workspace.machines.exec(
				workspace.vm,
				`python3 -c ${quote(WRITE_SCRIPT)} ${quote(payload)}`,
				30_000,
			);
			if (result.exitCode)
				throw new Error(
					`Could not write ${path}: ${result.stderr.slice(-400)}`.trim(),
				);
			const written = JSON.parse(result.stdout) as {
				path: string;
				error?: string;
				created?: boolean;
				bytes?: number;
				lines?: number;
			};
			if (written.error === "stale")
				throw new LeanEditError(
					`${path} changed while it was being edited; read it again and retry.`,
				);
			if (written.error)
				throw new LeanEditError(`Could not write ${path}: ${written.error}.`);
			return written as {
				path: string;
				created: boolean;
				bytes: number;
				lines: number;
			};
		},
		/** Reads, applies `change` to the current text, and writes back unless the file changed meanwhile. */
		async editFile(
			path: string,
			change: (content: string | null) => {
				content: string;
				replacements: number;
				fuzzy: boolean;
			},
		) {
			const current = await this.readWhole(path);
			const edited = change(current.content);
			const written = await this.writeFile(
				path,
				edited.content,
				current.sha256,
			);
			return { ...edited, path: written.path, created: written.created };
		},
		/** A quick read-only search command (rg); output limited with the head kept. */
		async search(command: string, emptyMessage: string) {
			const workspace = await ready();
			const result = await workspace.machines.exec(
				workspace.vm,
				`cd ${quote(workspace.cwd)} && ${command}`,
				60_000,
			);
			if (result.exitCode > 1)
				throw new Error(
					result.stderr.trim().slice(-600) ||
						`Search failed (exit ${result.exitCode}).`,
				);
			if (!result.stdout.trim()) return emptyMessage;
			const truncation = truncateHead(result.stdout);
			return truncation.truncated
				? `${truncation.content}[Showing the first ${truncation.lastLine} of ${truncation.totalLines} lines; narrow the search to see the rest.]`
				: truncation.content;
		},
		once,
		cwd: async () => (await ready()).cwd,
	};
}

type LeanEngine = ReturnType<typeof leanEngine>;

const imageOutput = (output: unknown) => {
	const read = output as { image?: string; base64?: string; path?: string };
	return read.image && read.base64
		? {
				type: "content" as const,
				value: [
					{ type: "text" as const, text: `Image ${read.path}` },
					{
						type: "file" as const,
						data: { type: "data" as const, data: read.base64 },
						mediaType: read.image,
					},
				],
			}
		: null;
};

const textOutput = (value: unknown) => ({
	type: "text" as const,
	value: typeof value === "string" ? value : JSON.stringify(value),
});

type ReadView = "claude" | "gemini" | "pi";

/** A file read in each harness's own format; images as images. */
async function readForModel(
	engine: LeanEngine,
	view: ReadView,
	path: string,
	offset: number | undefined,
	limit: number | undefined,
) {
	const start = offset && offset > 0 ? offset : 1;
	const read = await engine.readFile(path, {
		offset: start,
		limit: Math.min(
			limit && limit > 0 ? limit : LEAN_MAX_LINES,
			LEAN_MAX_LINES,
		),
		maxLineCharacters: view === "claude" ? 2000 : 0,
	});
	if ("missing" in read) throw new Error(`File does not exist: ${read.path}`);
	if ("directory" in read)
		throw new Error(
			`${read.path} is a directory, not a file. It contains: ${read.entries.join(", ")}`,
		);
	if ("binary" in read)
		throw new Error(`${read.path} is a binary file (${read.bytes} bytes).`);
	if ("error" in read) throw new Error(`${read.path}: ${read.error}.`);
	if ("image" in read) {
		const mediaType = detectMediaType({
			data: read.base64,
			topLevelType: "image",
		});
		return { ...read, image: mediaType ?? read.image };
	}
	const last = read.startLine + read.lines.length - 1;
	const more = read.cut || last < read.totalLines;
	if (!read.lines.length) {
		if (read.totalLines === 0)
			return view === "claude"
				? "<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>"
				: "(empty file)";
		throw new Error(
			`${view === "gemini" ? "start_line" : "offset"} ${start} is beyond the end of ${read.path} (${read.totalLines} lines).`,
		);
	}
	const body =
		view === "claude"
			? read.lines
					.map(
						(line, index) =>
							`${String(read.startLine + index).padStart(6)}\t${line}`,
					)
					.join("\n")
			: read.lines.join("\n");
	if (!more) return body;
	const next = last + 1;
	return view === "gemini"
		? `IMPORTANT: The file content has been truncated.\nStatus: Showing lines ${read.startLine}-${last} of ${read.totalLines} total lines.\nAction: To read more of the file, use start_line: ${next}.\n\n--- FILE CONTENT (truncated) ---\n${body}`
		: `${body}\n\n[Showing lines ${read.startLine}-${last} of ${read.totalLines}. Use offset=${next} to continue.]`;
}

const editNote = (
	edited: { replacements: number; fuzzy: boolean },
	path: string,
	created: boolean,
) =>
	created
		? `Created ${path}.`
		: `The file ${path} has been updated (${edited.replacements} ${edited.replacements === 1 ? "replacement" : "replacements"}).${edited.fuzzy ? " The text matched after normalizing whitespace, quotes or dashes; only the matched region changed." : ""}`;

async function leanEdit(
	engine: LeanEngine,
	name: string,
	args: Record<string, unknown>,
	options: ExecuteOptions,
	path: string,
	edit: { old: string; new: string; all?: boolean },
	names: LeanEditNames,
) {
	return engine.once(name, args, options, async () => {
		const edited = await engine.editFile(path, (content) =>
			applyLeanEdit(content, edit, path, names),
		);
		return editNote(edited, edited.path, edited.created);
	});
}

const writeFile = (
	engine: LeanEngine,
	name: string,
	args: Record<string, unknown>,
	options: ExecuteOptions,
	path: string,
	content: string,
) =>
	engine.once(name, args, options, async () => {
		const written = await engine.writeFile(path, content);
		return `${written.created ? "Created" : "Overwrote"} ${written.path} (${written.lines} lines).`;
	});

const backgroundHint = (result: LeanCommandResult) =>
	`Output is being written to ${result.outputPath}. Check it with \`ytimesy-job status ${result.id}\`, wait for it with \`ytimesy-job wait ${result.id}\`, stop it with \`ytimesy-job stop ${result.id}\`.`;

const exitText = (result: LeanCommandResult) =>
	result.stopped === "timeout"
		? `${result.status} (stopped at its time limit)`
		: result.stopped === "output_limit"
			? `${result.status} (stopped: output exceeded 16 MB)`
			: String(result.status);

const withNote = (text: string, result: LeanCommandResult) =>
	[text, result.truncationNote, result.note].filter(Boolean).join("\n");

const globCommand = (pattern: string, base: string | undefined) =>
	`rg --files --hidden --no-messages -g '!.git' -g ${quote(pattern)} --sortr modified -- ${quote(base || ".")} | head -n 101 | python3 -c ${quote("import os,sys; lines=[os.path.abspath(l.rstrip('\\n')) for l in sys.stdin]; print('\\n'.join(lines[:100])); print('(Results are truncated: more than 100 files. Use a more specific path or pattern.)' if len(lines) > 100 else '', end='')")}`;

const PATCH_PATH_HEADER =
	/^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.*)$/;

/**
 * A Codex patch with absolute file headers inside the repository rewritten to
 * repository-relative ones. Paths outside the repository are left for the
 * patch parser to refuse. The root is read only when a header is absolute.
 */
export async function relativePatchPaths(
	patch: string,
	root: () => Promise<string>,
): Promise<string> {
	const lines = patch.split("\n");
	if (
		!lines.some((line) =>
			PATCH_PATH_HEADER.exec(line)?.[2].trim().startsWith("/"),
		)
	)
		return patch;
	const base = (await root()).replace(/\/+$/, "");
	return lines
		.map((line) => {
			const match = PATCH_PATH_HEADER.exec(line);
			const path = match?.[2].trim();
			return match &&
				path?.startsWith(`${base}/`) &&
				path.length > base.length + 1
				? `${match[1]}${path.slice(base.length + 1)}`
				: line;
		})
		.join("\n");
}

/** Codex's tools: a PTY-style session shell, freeform apply_patch, view_image. */
function codexTools(engine: LeanEngine, base: ToolSet): ToolSet {
	const view = (result: LeanCommandResult) =>
		withNote(
			[
				`Wall time: ${result.wallSeconds} seconds`,
				result.status === "running"
					? `Process running with session ID ${result.id}`
					: result.status === "interrupted"
						? "Process was interrupted"
						: `Process exited with code ${exitText(result)}`,
				"Output:",
				result.output,
			].join("\n"),
			result,
		);
	const tokensToBytes = (tokens?: number) =>
		tokens ? Math.min(LEAN_MAX_BYTES, Math.max(400, tokens * 4)) : undefined;
	const patch = base.apply_patch;
	const freeform =
		(patch as { id?: string } | undefined)?.id === "openai.custom" ||
		patch?.type === "provider";
	return {
		exec_command: tool({
			description:
				"Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
			inputSchema: z.object({
				cmd: z
					.string()
					.min(1)
					.max(16_000)
					.describe("Shell command to execute."),
				workdir: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"Optional working directory to run the command in; defaults to the repository root.",
					),
				yield_time_ms: z
					.number()
					.int()
					.min(0)
					.max(600_000)
					.optional()
					.describe(
						"How long to wait (in milliseconds) for output before yielding (default 10000, at most 30000).",
					),
				max_output_tokens: z
					.number()
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe(
						"Maximum number of tokens to return. Excess output will be truncated.",
					),
			}),
			execute: ({ cmd, workdir, yield_time_ms, max_output_tokens }, options) =>
				engine.run(
					{
						command: cmd,
						workdir,
						maxSeconds: 600,
						yieldSeconds: (yield_time_ms ?? 10_000) / 1000,
						maxBytes: tokensToBytes(max_output_tokens),
					},
					options,
				),
			toModelOutput: ({ output }) =>
				textOutput(view(output as LeanCommandResult)),
		}),
		write_stdin: tool({
			description:
				'Writes characters to an existing exec session and returns its output since the last read. Empty chars polls (waits up to yield_time_ms, or until it exits). "\\u0003" (Ctrl-C) stops the process; "\\u0004" sends EOF.',
			inputSchema: z.object({
				session_id: z
					.string()
					.min(1)
					.max(100)
					.describe("Session ID returned by exec_command."),
				chars: z
					.string()
					.max(8192)
					.optional()
					.describe("Bytes to write to stdin (may be empty to poll)."),
				yield_time_ms: z
					.number()
					.int()
					.min(0)
					.max(600_000)
					.optional()
					.describe(
						"How long to wait (in milliseconds) for output before yielding.",
					),
				max_output_tokens: z
					.number()
					.int()
					.min(1)
					.max(100_000)
					.optional()
					.describe(
						"Maximum number of tokens to return. Excess output will be truncated.",
					),
			}),
			execute: async (
				{ session_id, chars, yield_time_ms, max_output_tokens },
				options,
			) => {
				if (!z.uuid().safeParse(session_id).success)
					throw new Error(
						`Unknown session ID ${JSON.stringify(session_id)}; use the ID exec_command returned.`,
					);
				return engine.write(
					{
						id: session_id,
						chars: chars ?? "",
						yieldSeconds:
							yield_time_ms === undefined
								? chars
									? 10
									: undefined
								: yield_time_ms / 1000,
						maxBytes: tokensToBytes(max_output_tokens),
					},
					options,
				);
			},
			toModelOutput: ({ output }) =>
				textOutput(view(output as LeanCommandResult)),
		}),
		...(patch
			? {
					apply_patch: freeform
						? ({
								...patch,
								// Codex's own apply_patch accepts absolute paths inside the
								// workspace; the shared parser takes repository-relative ones.
								execute: async (input: string, options: never) =>
									(patch.execute as (input: string, options: never) => unknown)(
										await relativePatchPaths(input, engine.cwd),
										options,
									),
							} as typeof patch)
						: tool({
								description:
									"Use the `apply_patch` tool to edit files. The patch is a stripped-down, file-oriented diff:\n*** Begin Patch\n[ one or more file sections ]\n*** End Patch\nEach section starts with *** Add File: <path> (every following line starts with +), *** Delete File: <path>, or *** Update File: <path> (optionally followed by *** Move to: <path>), then hunks introduced by @@ (optionally @@ <enclosing class or function>), with 3 lines of context before and after each change, ' ' for context, '-' for removed and '+' for added lines. File paths are relative, never absolute.",
								inputSchema: z.object({
									input: z
										.string()
										.min(1)
										.max(200_000)
										.describe(
											"The entire contents of the apply_patch command.",
										),
								}),
								execute: async ({ input }, options) => {
									const execute = patch.execute;
									if (!execute) throw new Error("apply_patch is unavailable.");
									return execute(
										{
											patch: await relativePatchPaths(input, engine.cwd),
										} as never,
										options,
									);
								},
							}),
				}
			: {}),
		view_image: tool({
			description:
				"Attach a local image (by filesystem path) to the conversation context for this turn.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.max(4096)
					.describe("Local filesystem path to an image file"),
			}),
			execute: async ({ path }) => {
				const read = await readForModel(engine, "pi", path, 1, 1);
				if (typeof read === "string" || !("image" in read))
					throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
				return read;
			},
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
	};
}

/** Claude Code's tools. */
function claudeTools(engine: LeanEngine): ToolSet {
	return {
		Bash: tool({
			description:
				"Executes a bash command in the workspace and returns its output. Each call starts in the repository root; the filesystem persists. timeout is in milliseconds (default 120000, max 600000). Set run_in_background to start a long-running process (a dev server, a watcher) and get its ID and output file instead of waiting.",
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(16_000)
					.describe("The command to execute"),
				timeout: z
					.number()
					.int()
					.min(1)
					.max(600_000)
					.optional()
					.describe("Optional timeout in milliseconds (max 600000)"),
				description: z
					.string()
					.max(500)
					.optional()
					.describe(
						"Clear, concise description of what this command does in 5-10 words",
					),
				run_in_background: z
					.boolean()
					.optional()
					.describe("Set to true to run this command in the background."),
			}),
			execute: ({ command, timeout, run_in_background }, options) => {
				const seconds = (timeout ?? 120_000) / 1000;
				return engine.run(
					run_in_background
						? { command, maxSeconds: 600, yieldSeconds: 0 }
						: {
								command,
								maxSeconds: seconds,
								yieldSeconds: Math.min(30, seconds),
								waitSeconds: seconds,
							},
					options,
				);
			},
			toModelOutput: ({ output }) => {
				const result = output as LeanCommandResult;
				if (result.status === "running")
					return textOutput(
						`Command running in background with ID: ${result.id}. ${backgroundHint(result)}${result.output ? `\nOutput so far:\n${result.output}` : ""}`,
					);
				return textOutput(
					withNote(
						[
							result.output || "(no output)",
							result.status === 0 ? "" : `Exit code ${exitText(result)}`,
						]
							.filter(Boolean)
							.join("\n"),
						result,
					),
				);
			},
		}),
		Read: tool({
			description:
				"Reads a file. file_path should be absolute (relative paths resolve from the repository root). Returns up to 2000 lines in cat -n format, starting at offset (a 1-based line number) for up to limit lines; longer lines are cut at 2000 characters. Images (PNG, JPEG, GIF, WebP) are shown to you as images.",
			inputSchema: z.object({
				file_path: z
					.string()
					.min(1)
					.max(4096)
					.describe("The absolute path to the file to read"),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The line number to start reading from"),
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The number of lines to read"),
			}),
			execute: ({ file_path, offset, limit }) =>
				readForModel(engine, "claude", file_path, offset, limit),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		Write: tool({
			description:
				"Writes a file, replacing it if it exists and creating parent directories. Prefer Edit for changes to existing files.",
			inputSchema: z.object({
				file_path: z
					.string()
					.min(1)
					.max(4096)
					.describe("The absolute path to the file to write"),
				content: z
					.string()
					.max(5_000_000)
					.describe("The content to write to the file"),
			}),
			execute: (args, options) =>
				writeFile(engine, "Write", args, options, args.file_path, args.content),
		}),
		Edit: tool({
			description:
				"Performs an exact string replacement in a file. old_string must match exactly one place (include surrounding lines to make it unique) unless replace_all is true. An empty old_string creates a new file.",
			inputSchema: z.object({
				file_path: z
					.string()
					.min(1)
					.max(4096)
					.describe("The absolute path to the file to modify"),
				old_string: z.string().max(1_000_000).describe("The text to replace"),
				new_string: z
					.string()
					.max(1_000_000)
					.describe(
						"The text to replace it with (must be different from old_string)",
					),
				replace_all: z
					.boolean()
					.optional()
					.describe("Replace all occurrences of old_string (default false)"),
			}),
			execute: (args, options) =>
				leanEdit(
					engine,
					"Edit",
					args,
					options,
					args.file_path,
					{ old: args.old_string, new: args.new_string, all: args.replace_all },
					{ old: "old_string", all: "replace_all" },
				),
		}),
		Glob: tool({
			description:
				'Fast file pattern matching (e.g. "**/*.js" or "src/**/*.ts"). Returns matching file paths, most recently modified first.',
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(1000)
					.describe("The glob pattern to match files against"),
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"The directory to search in (default: the repository root)",
					),
			}),
			execute: ({ pattern, path }) =>
				engine.search(globCommand(pattern, path), "No files found"),
		}),
		Grep: tool({
			description:
				"Searches file contents with ripgrep (regular expressions). output_mode: files_with_matches (default) lists files, content shows matching lines, count shows match counts.",
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(2000)
					.describe("The regular expression pattern to search for"),
				path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"File or directory to search in (default: the repository root)",
					),
				glob: z
					.string()
					.max(1000)
					.optional()
					.describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
				output_mode: z
					.enum(["content", "files_with_matches", "count"])
					.optional(),
				"-i": z.boolean().optional().describe("Case insensitive search"),
				"-C": z
					.number()
					.int()
					.min(0)
					.max(50)
					.optional()
					.describe("Lines of context around each match (content mode)"),
				head_limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Limit output to the first N lines or entries"),
			}),
			execute: (args) => {
				const mode = args.output_mode ?? "files_with_matches";
				const flags = [
					"--hidden",
					"--no-messages",
					"--max-columns=500",
					"--max-columns-preview",
					"-g",
					"!.git",
					...(mode === "files_with_matches"
						? ["-l"]
						: mode === "count"
							? ["-c"]
							: ["-n"]),
					...(args["-i"] ? ["-i"] : []),
					...(mode === "content" && args["-C"] !== undefined
						? ["-C", String(args["-C"])]
						: []),
					...(args.glob ? ["-g", args.glob] : []),
				];
				return engine.search(
					`rg ${flags.map(quote).join(" ")} -e ${quote(args.pattern)} -- ${quote(args.path || ".")}${args.head_limit ? ` | head -n ${args.head_limit}` : ""}`,
					"No matches found",
				);
			},
		}),
	};
}

/** Gemini CLI's tools; Qwen Code names its edit tool `edit` with replace_all. */
function geminiTools(engine: LeanEngine, qwen: boolean): ToolSet {
	const editSchema = {
		file_path: z
			.string()
			.min(1)
			.max(4096)
			.describe("The path to the file to modify."),
		old_string: z
			.string()
			.max(1_000_000)
			.describe(
				"The exact literal text to replace, including whitespace and indentation.",
			),
		new_string: z
			.string()
			.max(1_000_000)
			.describe("The exact literal text to replace old_string with."),
	};
	const editDescription = (flag: string) =>
		`Replaces text within a file. old_string must match exactly one occurrence (copy it with its whitespace and indentation, with enough surrounding context to be unique) unless ${flag} is true. An empty old_string creates a new file.`;
	return {
		run_shell_command: tool({
			description:
				"Executes a shell command as `bash -c <command>` in the workspace and returns its output and exit code. dir_path runs it in that directory (default: the repository root). is_background starts a long-running process (a server, a watcher) and returns its ID and output file instead of waiting.",
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(16_000)
					.describe("Exact bash command to execute as `bash -c <command>`"),
				description: z
					.string()
					.max(500)
					.optional()
					.describe("Brief description of the command for the user."),
				dir_path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"Directory to run the command in (default: the repository root).",
					),
				is_background: z
					.boolean()
					.optional()
					.describe("Run the command in the background."),
			}),
			execute: ({ command, dir_path, is_background }, options) =>
				engine.run(
					is_background
						? { command, workdir: dir_path, maxSeconds: 600, yieldSeconds: 0 }
						: {
								command,
								workdir: dir_path,
								maxSeconds: 600,
								yieldSeconds: 30,
								waitSeconds: 600,
							},
					options,
				),
			toModelOutput: ({ output, input }) => {
				const result = output as LeanCommandResult;
				const args = input as { dir_path?: string };
				if (result.status === "running")
					return textOutput(
						`Command started in background with ID ${result.id}. ${backgroundHint(result)}${result.output ? `\nOutput so far:\n${result.output}` : ""}`,
					);
				return textOutput(
					withNote(
						[
							`Command: ${result.command}`,
							`Directory: ${args?.dir_path || "(root)"}`,
							`Output: ${result.output || "(empty)"}`,
							`Exit Code: ${exitText(result)}`,
						].join("\n"),
						result,
					),
				);
			},
		}),
		read_file: tool({
			description:
				"Reads a file (absolute, or relative to the repository root). start_line and end_line (1-based, inclusive) select lines; at most 2000 lines are returned. Images (PNG, JPEG, GIF, WebP) are returned as images.",
			inputSchema: z.object({
				file_path: z
					.string()
					.min(1)
					.max(4096)
					.describe("The path to the file to read."),
				start_line: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The 1-based line number to start reading from."),
				end_line: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("The 1-based line number to end reading at (inclusive)."),
			}),
			execute: ({ file_path, start_line, end_line }) =>
				readForModel(
					engine,
					"gemini",
					file_path,
					start_line,
					end_line ? end_line - (start_line ?? 1) + 1 : undefined,
				),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		write_file: tool({
			description:
				"Writes content to a file, creating it (and parent directories) or overwriting it.",
			inputSchema: z.object({
				file_path: z
					.string()
					.min(1)
					.max(4096)
					.describe("The path to the file to write to."),
				content: z
					.string()
					.max(5_000_000)
					.describe("The content to write to the file."),
			}),
			execute: (args, options) =>
				writeFile(
					engine,
					"write_file",
					args,
					options,
					args.file_path,
					args.content,
				),
		}),
		...(qwen
			? {
					edit: tool({
						description: editDescription("replace_all"),
						inputSchema: z.object({
							...editSchema,
							replace_all: z
								.boolean()
								.optional()
								.describe(
									"Replace all occurrences of old_string (default false).",
								),
						}),
						execute: (args, options) =>
							leanEdit(
								engine,
								"edit",
								args,
								options,
								args.file_path,
								{
									old: args.old_string,
									new: args.new_string,
									all: args.replace_all,
								},
								{ old: "old_string", all: "replace_all" },
							),
					}),
				}
			: {
					replace: tool({
						description: editDescription("allow_multiple"),
						inputSchema: z.object({
							...editSchema,
							allow_multiple: z
								.boolean()
								.optional()
								.describe(
									"Replace every occurrence of old_string (default false).",
								),
						}),
						execute: (args, options) =>
							leanEdit(
								engine,
								"replace",
								args,
								options,
								args.file_path,
								{
									old: args.old_string,
									new: args.new_string,
									all: args.allow_multiple,
								},
								{ old: "old_string", all: "allow_multiple" },
							),
					}),
				}),
		glob: tool({
			description:
				'Finds files matching a glob pattern (e.g. "src/**/*.ts"), most recently modified first.',
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(1000)
					.describe("The glob pattern to match against."),
				dir_path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"The directory to search within (default: the repository root).",
					),
			}),
			execute: ({ pattern, dir_path }) =>
				engine.search(globCommand(pattern, dir_path), "No files found"),
		}),
		grep_search: tool({
			description:
				"Searches file contents for a regular expression (ripgrep) and returns matching lines with file paths and line numbers.",
			inputSchema: z.object({
				pattern: z
					.string()
					.min(1)
					.max(2000)
					.describe("The regular expression to search for."),
				dir_path: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"The directory to search within (default: the repository root).",
					),
				include: z
					.string()
					.max(1000)
					.optional()
					.describe(
						'A glob pattern to filter files (e.g. "*.js", "src/**/*.{ts,tsx}").',
					),
			}),
			execute: ({ pattern, dir_path, include }) =>
				engine.search(
					`rg --hidden --no-messages --max-columns=500 --max-columns-preview -n -g '!.git' ${include ? `-g ${quote(include)} ` : ""}-e ${quote(pattern)} -- ${quote(dir_path || ".")}`,
					`No matches found for pattern "${pattern}".`,
				),
		}),
	};
}

/** Pi's four tools: one neutral shape for every model. */
function piTools(engine: LeanEngine): ToolSet {
	return {
		read: tool({
			description:
				"Read the contents of a file. Supports text files and images (jpg, png, gif, webp); images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.max(4096)
					.describe("Path to the file to read (relative or absolute)"),
				offset: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Line number to start reading from (1-indexed)"),
				limit: z
					.number()
					.int()
					.min(1)
					.optional()
					.describe("Maximum number of lines to read"),
			}),
			execute: ({ path, offset, limit }) =>
				readForModel(engine, "pi", path, offset, limit),
			toModelOutput: ({ output }) => imageOutput(output) ?? textOutput(output),
		}),
		write: tool({
			description:
				"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.max(4096)
					.describe("Path to the file to write (relative or absolute)"),
				content: z
					.string()
					.max(5_000_000)
					.describe("Content to write to the file"),
			}),
			execute: (args, options) =>
				writeFile(engine, "write", args, options, args.path, args.content),
		}),
		edit: tool({
			description:
				"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file (each is matched against the original, not after earlier edits). Use one call with several edits for several changes to the same file.",
			inputSchema: z.object({
				path: z
					.string()
					.min(1)
					.max(4096)
					.describe("Path to the file to edit (relative or absolute)"),
				edits: z
					.array(
						z.object({
							oldText: z
								.string()
								.min(1)
								.max(1_000_000)
								.describe("Exact text to find and replace"),
							newText: z.string().max(1_000_000).describe("Replacement text"),
						}),
					)
					.min(1)
					.max(50),
			}),
			execute: (args, options) =>
				engine.once("edit", args, options, async () => {
					const edited = await engine.editFile(args.path, (content) =>
						applyLeanEdits(content, args.edits, args.path),
					);
					return `Successfully replaced ${edited.replacements} block(s) in ${edited.path}.${edited.fuzzy ? " (Matched after normalizing whitespace, quotes or dashes; only the matched regions changed.)" : ""}`;
				}),
		}),
		bash: tool({
			description:
				"Execute a bash command in the repository root. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); the full output is saved to a file. Optionally provide a timeout in seconds (at most 600).",
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(16_000)
					.describe("Bash command to execute"),
				timeout: z
					.number()
					.min(1)
					.max(600)
					.optional()
					.describe("Timeout in seconds (optional, at most 600)"),
			}),
			execute: ({ command, timeout }, options) =>
				engine.run(
					{
						command,
						maxSeconds: timeout ?? 600,
						yieldSeconds: Math.min(30, timeout ?? 30),
						waitSeconds: timeout ?? 600,
					},
					options,
				),
			toModelOutput: ({ output }) => {
				const result = output as LeanCommandResult;
				if (result.status === "running")
					return textOutput(
						`Still running after ${result.wallSeconds} seconds (ID ${result.id}). ${backgroundHint(result)}${result.output ? `\nOutput so far:\n${result.output}` : ""}`,
					);
				return textOutput(
					withNote(
						[
							result.output || "(no output)",
							result.stopped === "timeout"
								? `Command timed out (exit ${result.status})`
								: result.status === 0
									? ""
									: `Command exited with code ${exitText(result)}`,
						]
							.filter(Boolean)
							.join("\n\n"),
						result,
					),
				);
			},
		}),
	};
}

/** The tools a lean shape offers, over the runtime's command tools in `base`. */
export function leanShapeTools(
	shape: LeanToolShape,
	base: ToolSet,
	context: LeanSurfaceContext,
): { tools: ToolSet; engine: LeanEngine } {
	const engine = leanEngine(base, context);
	const tools =
		shape === "codex"
			? codexTools(engine, base)
			: shape === "claude"
				? claudeTools(engine)
				: shape === "gemini" || shape === "qwen"
					? geminiTools(engine, shape === "qwen")
					: piTools(engine);
	return { tools, engine };
}
