import { leanToolRole } from "./harness-model-profile";
import type { DynamicToolCallItem } from "./session-item";
import { toolOutputText } from "./tool-detail";

/**
 * What an opened tool card shows, read from the call's recorded input and
 * output: a command with its output and exit, a file's lines, an edit as a
 * diff, a written file; anything else as its fields.
 */
export type ToolDetailView =
	| {
			kind: "command";
			command: string;
			output: string;
			/** The exit code, or the command's other end ("timeout", "running"). */
			exit: number | "timeout" | "running" | null;
			note?: string;
	  }
	| {
			kind: "read";
			path: string;
			startLine: number;
			lines: string[];
			/** The file's length when the read showed only part of it. */
			totalLines?: number;
			note?: string;
	  }
	| {
			kind: "edit";
			path: string;
			hunks: { removed: string; added: string }[];
			note?: string;
	  }
	| { kind: "write"; path: string; content: string; note?: string }
	| { kind: "patch"; diff: string }
	| { kind: "fields"; input?: string; output?: string };

function json(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" && !Array.isArray(value)
			? value
			: null;
	} catch {
		return null;
	}
}

const string = (value: unknown) =>
	typeof value === "string" ? value : undefined;

/** A model-facing output value ({type: "text", value}) or plain text. */
function shownText(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	const record = value as Record<string, unknown> | null;
	if (record?.type === "text" && typeof record.value === "string")
		return record.value;
	return undefined;
}

const EXIT_LINE =
	/\n?(?:exit (-?\d+)|Command exited with code (-?\d+)[^\n]*)\s*$/;
const TIMEOUT_LINE = /\n*Command timed out \(exit (-?\d+)\)\s*$/;
const NOTE_LINE = /\n*(\[(?:Output|Showing|Lines)[^\n]*\])\s*$/;

/** A command's recorded output: lean result JSON, run_code's {output, exitCode}, or text ending in its exit. */
function commandResult(raw: string | undefined): {
	output: string;
	exit: number | "timeout" | "running" | null;
	note?: string;
} {
	const value = json(raw);
	if (value && "outputPath" in value && typeof value.output === "string") {
		const status = value.status;
		return {
			output: value.output,
			exit:
				value.stopped === "timeout"
					? "timeout"
					: typeof status === "number"
						? status
						: status === "running"
							? "running"
							: null,
			note: string(value.truncationNote),
		};
	}
	if (value && "exitCode" in value) {
		const inner = commandResult(shownText(value.output) ?? "");
		return {
			...inner,
			exit:
				value.running === true
					? "running"
					: typeof value.exitCode === "number"
						? inner.exit === "timeout"
							? "timeout"
							: value.exitCode
						: inner.exit,
		};
	}
	let output = raw ?? "";
	let exit: number | "timeout" | "running" | null = null;
	const timeout = TIMEOUT_LINE.exec(output);
	if (timeout) {
		exit = "timeout";
		output = output.slice(0, timeout.index);
	} else {
		const ended = EXIT_LINE.exec(output);
		if (ended) {
			exit = Number(ended[1] ?? ended[2]);
			output = output.slice(0, ended.index);
		} else if (
			/^(?:running \(|Still running after|Started in the background)/m.test(
				output,
			)
		)
			exit = "running";
	}
	const note = NOTE_LINE.exec(output);
	if (note) output = output.slice(0, note.index);
	if (output.trim() === "(no output)") output = "";
	return { output: output.replace(/\s+$/, ""), exit, note: note?.[1] };
}

const READ_NOTE = /\n*(\[Lines \d+-\d+ of \d+;[^\n]*\])\s*$/;
const GEMINI_HEADER =
	/^IMPORTANT: The file content has been truncated\.\n(Status: [^\n]*)\n[^\n]*\n\n--- FILE CONTENT \(truncated\) ---\n/;
const NUMBERED = /^\s*(\d+)\t(.*)$/;

/** A read's lines; Claude-shaped reads number each line ("     1\tcode"). */
function readResult(raw: string, offset: number) {
	let text = toolOutputText(raw);
	let note: string | undefined;
	const gemini = GEMINI_HEADER.exec(text);
	if (gemini) {
		note = gemini[1];
		text = text.slice(gemini[0].length);
	}
	let totalLines: number | undefined;
	const tail = READ_NOTE.exec(text);
	if (tail) {
		// "[Lines 1-40 of 120; read on from offset 41.]" is for the model; the card shows "of 120".
		totalLines = Number(/ of (\d+);/.exec(tail[1] as string)?.[1]);
		text = text.slice(0, tail.index);
	}
	if (gemini)
		totalLines = Number(/ of (\d+) total/.exec(note ?? "")?.[1]) || undefined;
	if (totalLines) note = undefined;
	const lines = text.split("\n");
	const numbered =
		lines.length > 0 && lines.every((line) => NUMBERED.test(line));
	if (numbered) {
		const first = Number(NUMBERED.exec(lines[0] as string)?.[1]);
		return {
			startLine: first,
			lines: lines.map((line) => NUMBERED.exec(line)?.[2] ?? line),
			totalLines,
			note,
		};
	}
	return { startLine: offset, lines, totalLines, note };
}

export function toolDetailView(item: DynamicToolCallItem): ToolDetailView {
	const input = json(item.input) ?? {};
	const text = (...keys: string[]) => {
		for (const key of keys) {
			const value = string(input[key]);
			if (value !== undefined) return value;
		}
		return undefined;
	};
	const failed = item.status === "failed";
	const role =
		leanToolRole(item.tool) ??
		(["execute_command", "start_command", "shell"].includes(item.tool)
			? "command"
			: undefined);
	const path = text("file_path", "path", "absolute_path");
	if (role === "command") {
		const command = text("command", "cmd");
		if (command) {
			if (failed)
				return {
					kind: "command",
					command,
					output: "",
					exit: null,
					note: item.output ? toolOutputText(item.output) : undefined,
				};
			return { kind: "command", command, ...commandResult(item.output) };
		}
	}
	if (role === "read" && path && item.output && !failed) {
		const offset = input.offset ?? input.start_line;
		return {
			kind: "read",
			path,
			...readResult(
				item.output,
				typeof offset === "number" && offset > 0 ? offset : 1,
			),
		};
	}
	if (role === "edit" && path) {
		const edits = Array.isArray(input.edits)
			? (input.edits as Record<string, unknown>[])
			: [input];
		const hunks = edits.map((edit) => ({
			removed: string(edit.old_string ?? edit.oldText) ?? "",
			added: string(edit.new_string ?? edit.newText) ?? "",
		}));
		if (hunks.some((hunk) => hunk.removed || hunk.added))
			return {
				kind: "edit",
				path,
				hunks,
				note: item.output ? toolOutputText(item.output) : undefined,
			};
	}
	if (role === "write" && path) {
		const content = text("content");
		if (content !== undefined)
			return {
				kind: "write",
				path,
				content,
				note: item.output ? toolOutputText(item.output) : undefined,
			};
	}
	if (item.tool === "apply_patch") {
		const patch =
			text("patch", "input") ??
			(item.input && !json(item.input) ? item.input : undefined);
		if (patch) return { kind: "patch", diff: patch };
	}
	return {
		kind: "fields",
		input: item.input,
		output: item.output ? toolOutputText(item.output) : undefined,
	};
}
