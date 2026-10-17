import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { LEAN_SHAPE_TOOLS } from "#/domain/harness-model-profile";
import { applyLeanEdits } from "../lean-edit";
import {
	LEAN_COMMAND_MAX_SECONDS,
	LEAN_YIELD_MAX_SECONDS,
	type LeanCommandResult,
	type LeanEngine,
} from "../lean-engine";
import {
	backgroundHint,
	COMMAND_MAX_CHARACTERS,
	EDIT_TEXT_MAX_CHARACTERS,
	exitText,
	imageOutput,
	outputSoFar,
	pathArgument,
	readForModel,
	textOutput,
	WRITE_CONTENT_MAX_CHARACTERS,
	withNote,
	writeFile,
} from "./common";

/** Pi's four tools: one neutral shape for every model. */
export function piTools(engine: LeanEngine): ToolSet {
	const names = LEAN_SHAPE_TOOLS.pi;
	return {
		[names.read]: tool({
			description:
				"Read the contents of a file. Supports text files and images (jpg, png, gif, webp); images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files.",
			inputSchema: z.object({
				path: pathArgument("Path to the file to read (relative or absolute)"),
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
		[names.write]: tool({
			description:
				"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
			inputSchema: z.object({
				path: pathArgument("Path to the file to write (relative or absolute)"),
				content: z
					.string()
					.max(WRITE_CONTENT_MAX_CHARACTERS)
					.describe("Content to write to the file"),
			}),
			execute: (args, options) =>
				writeFile(engine, names.write, args, options, args.path, args.content),
		}),
		[names.edit]: tool({
			description:
				"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file (each is matched against the original, not after earlier edits). Use one call with several edits for several changes to the same file.",
			inputSchema: z.object({
				path: pathArgument("Path to the file to edit (relative or absolute)"),
				edits: z
					.array(
						z.object({
							oldText: z
								.string()
								.min(1)
								.max(EDIT_TEXT_MAX_CHARACTERS)
								.describe("Exact text to find and replace"),
							newText: z
								.string()
								.max(EDIT_TEXT_MAX_CHARACTERS)
								.describe("Replacement text"),
						}),
					)
					.min(1)
					.max(50),
			}),
			execute: (args, options) =>
				engine.once(names.edit, args, options, async () => {
					const edited = await engine.editFile(args.path, (content) =>
						applyLeanEdits(content, args.edits, args.path),
					);
					return `Successfully replaced ${edited.replacements} block(s) in ${edited.path}.${edited.fuzzy ? " (Matched after normalizing whitespace, quotes or dashes; only the matched regions changed.)" : ""}`;
				}),
		}),
		[names.command]: tool({
			description: `Execute a bash command in the repository root. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB (whichever is hit first); the full output is saved to a file. Optionally provide a timeout in seconds (at most ${LEAN_COMMAND_MAX_SECONDS}).`,
			inputSchema: z.object({
				command: z
					.string()
					.min(1)
					.max(COMMAND_MAX_CHARACTERS)
					.describe("Bash command to execute"),
				timeout: z
					.number()
					.min(1)
					.max(LEAN_COMMAND_MAX_SECONDS)
					.optional()
					.describe(
						`Timeout in seconds (optional, at most ${LEAN_COMMAND_MAX_SECONDS})`,
					),
			}),
			execute: ({ command, timeout }, options) =>
				engine.run(
					{
						command,
						maxSeconds: timeout ?? LEAN_COMMAND_MAX_SECONDS,
						yieldSeconds: Math.min(
							LEAN_YIELD_MAX_SECONDS,
							timeout ?? LEAN_YIELD_MAX_SECONDS,
						),
						waitSeconds: timeout ?? LEAN_COMMAND_MAX_SECONDS,
					},
					options,
				),
			toModelOutput: ({ output }) => {
				const result = output as LeanCommandResult;
				if (result.status === "running")
					return textOutput(
						`Still running after ${result.wallSeconds} seconds (ID ${result.id}). ${backgroundHint(result)}${outputSoFar(result)}`,
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
