import type { Tool, ToolSet } from "ai";

/**
 * The output cap (harness variant outputCap): one tool result shows the
 * model at most `maxChars` characters of text. A longer result keeps its
 * head and its tail (errors and summaries come last) and says, between them,
 * how much was cut and where the rest is: a command's output file, a narrower
 * read, or a narrower command. The chat's own record of the call is
 * unchanged; only what the model reads is cut.
 */

/** Share of the cap kept from the start; the rest is kept from the end. */
const HEAD_SHARE = 0.4;

type ModelOutput = Awaited<ReturnType<NonNullable<Tool["toModelOutput"]>>>;

/** Where the cut part can be read again, from the tool's input and raw output. */
function restHint(input: unknown, output: unknown) {
	const path = (output as { outputPath?: unknown } | null)?.outputPath;
	if (typeof path === "string" && path)
		return `the full output is in ${path}; read the part you need with sed -n '<from>,<to>p' or grep -n`;
	const args = (input ?? {}) as Record<string, unknown>;
	if (["path", "file_path", "absolute_path"].some((key) => key in args))
		return "read the cut lines with a narrower offset and limit";
	return "narrow the call (filter with grep, head or tail) to see it";
}

/** Keeps the head and tail of `text` within `maxChars`, cut at line breaks where possible. */
export function capText(text: string, maxChars: number, hint: string) {
	if (text.length <= maxChars) return text;
	let head = text.slice(0, Math.floor(maxChars * HEAD_SHARE));
	const headBreak = head.lastIndexOf("\n");
	if (headBreak > head.length / 2) head = head.slice(0, headBreak + 1);
	let tail = text.slice(text.length - (maxChars - head.length));
	const tailBreak = tail.indexOf("\n");
	if (tailBreak >= 0 && tailBreak < tail.length / 2)
		tail = tail.slice(tailBreak + 1);
	const cut = text.slice(head.length, text.length - tail.length);
	const lines = cut.split("\n").length - (cut.endsWith("\n") ? 1 : 0);
	return `${head}${head.endsWith("\n") ? "" : "\n"}[... ${cut.length} characters (${lines} lines) cut from the middle of this ${text.length}-character result; ${hint} ...]\n${tail}`;
}

function capModelOutput(
	shown: ModelOutput,
	maxChars: number,
	hint: string,
): ModelOutput {
	switch (shown.type) {
		case "text":
		case "error-text":
			return { ...shown, value: capText(shown.value, maxChars, hint) };
		case "json":
		case "error-json": {
			const text = JSON.stringify(shown.value) ?? "null";
			return text.length <= maxChars
				? shown
				: {
						type: shown.type === "json" ? "text" : "error-text",
						value: capText(text, maxChars, hint),
					};
		}
		case "content":
			return {
				...shown,
				value: shown.value.map((part) =>
					part.type === "text"
						? { ...part, text: capText(part.text, maxChars, hint) }
						: part,
				),
			};
		default:
			return shown;
	}
}

/** Caps every executable tool's model output at `maxChars` (no-op when undefined). */
export function withOutputCap(tools: ToolSet, maxChars: number | undefined) {
	if (!maxChars) return tools;
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			if (!definition.execute) return [name, definition];
			const own = definition.toModelOutput;
			return [
				name,
				{
					...definition,
					toModelOutput: async (
						options: Parameters<NonNullable<Tool["toModelOutput"]>>[0],
					) => {
						const shown: ModelOutput = own
							? await own(options)
							: typeof options.output === "string"
								? { type: "text", value: options.output }
								: { type: "json", value: options.output ?? null };
						return capModelOutput(
							shown,
							maxChars,
							restHint(options.input, options.output),
						);
					},
				},
			];
		}),
	) as ToolSet;
}
