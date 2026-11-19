/**
 * What a finished thread produced, for Y² to report (the `thread` tool): its
 * final reply (long ones keep their start and their end, where findings and
 * conclusions sit), what it is waiting on the person for, any plan it
 * proposed, its error, and the canvases it showed. Built from the final
 * turn's few transcript rows, never the whole history.
 */

/** Most characters of a thread's final reply Y² reads. */
export const THREAD_REPLY_READ_LIMIT = 8_000;
const REPLY_HEAD = 5_500;
const REPLY_TAIL = THREAD_REPLY_READ_LIMIT - REPLY_HEAD;
const PLAN_LIMIT = 2_000;
const ERROR_LIMIT = 600;
const QUESTION_LIMIT = 400;

export type ThreadOutcomeItem =
	| {
			readonly kind: "agentMessage";
			readonly text?: string;
			readonly phase?: string;
			readonly streaming?: boolean;
	  }
	| { readonly kind: "planProposal"; readonly text?: string }
	| {
			readonly kind: "userQuestion";
			readonly questions?: readonly {
				readonly question?: string;
				readonly options?: readonly { readonly label?: string }[];
			}[];
	  }
	| {
			readonly kind: "error";
			readonly message?: string;
			readonly text?: string;
	  };

export type ThreadCanvas = {
	readonly title: string;
	/** The latest revision of this title (the highest number). */
	readonly revision: number;
	/** The document's size in KB; absent when not read. */
	readonly sizeKb?: number;
	readonly hasImages?: boolean;
	/** A short description of what it shows (about 300 characters), from its HTML. */
	readonly description?: string;
};

/** One canvas as a line of a thread's outcome: never its HTML. */
export function threadCanvasText(canvas: ThreadCanvas): string {
	const facts = [
		`revision ${canvas.revision}`,
		...(canvas.sizeKb === undefined ? [] : [`${canvas.sizeKb} KB`]),
		...(canvas.hasImages ? ["has images"] : []),
	].join(", ");
	return `- "${canvas.title}" (${facts})${canvas.description ? `: ${canvas.description}` : ""}`;
}

/** The last `n` characters' worth kept with a marker for what was cut. */
export function readableReply(text: string) {
	const flat = text.replace(/\r\n/g, "\n").trim();
	if (flat.length <= THREAD_REPLY_READ_LIMIT) return { text: flat, cut: 0 };
	const cut = flat.length - REPLY_HEAD - REPLY_TAIL;
	return {
		text: `${flat.slice(0, REPLY_HEAD)}\n[… ${cut.toLocaleString("en-US")} characters in the middle omitted …]\n${flat.slice(flat.length - REPLY_TAIL)}`,
		cut,
	};
}

/** The reply to report: the final answer when marked, else the last finished message. */
export function finalReplyOf(items: readonly ThreadOutcomeItem[]) {
	const messages = items.filter(
		(item): item is Extract<ThreadOutcomeItem, { kind: "agentMessage" }> =>
			item.kind === "agentMessage" &&
			!item.streaming &&
			typeof item.text === "string" &&
			item.text.trim().length > 0,
	);
	return (
		lastWhere(messages, (item) => item.phase === "final_answer") ??
		messages.at(-1) ??
		null
	);
}

/** The last element that matches (Array.prototype.findLast is past this project's target). */
function lastWhere<T>(list: readonly T[], match: (item: T) => boolean) {
	for (let index = list.length - 1; index >= 0; index--) {
		const item = list[index] as T;
		if (match(item)) return item;
	}
	return undefined;
}

const oneLine = (value: string, limit: number) => {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/** The sections of a thread's outcome as text lines (empty ones left out). */
export function threadOutcomeLines(input: {
	readonly items: readonly ThreadOutcomeItem[];
	readonly canvases: readonly ThreadCanvas[];
}): string[] {
	const lines: string[] = [];
	const reply = finalReplyOf(input.items);
	if (reply?.text) {
		const read = readableReply(reply.text);
		lines.push(
			read.cut
				? `Final reply (long, start and end shown; open the thread for the middle):\n${read.text}`
				: `Final reply:\n${read.text}`,
		);
	} else lines.push("No reply yet.");
	const plan = lastWhere(input.items, (item) => item.kind === "planProposal");
	if (plan?.kind === "planProposal" && plan.text?.trim())
		lines.push(
			`Plan it proposed (waiting for the person's approval):\n${plan.text.trim().slice(0, PLAN_LIMIT)}`,
		);
	const asked = lastWhere(input.items, (item) => item.kind === "userQuestion");
	if (asked?.kind === "userQuestion") {
		const questions = (asked.questions ?? []).flatMap((entry) => {
			if (!entry.question?.trim()) return [];
			const options = (entry.options ?? [])
				.map((option) => option.label?.trim())
				.filter(Boolean)
				.join(" / ");
			return [
				`- ${oneLine(entry.question, QUESTION_LIMIT)}${options ? ` [${options}]` : ""}`,
			];
		});
		if (questions.length)
			lines.push(`Questions it asked the person:\n${questions.join("\n")}`);
	}
	const failure = lastWhere(input.items, (item) => item.kind === "error");
	if (failure?.kind === "error") {
		const message = failure.message ?? failure.text;
		if (message?.trim()) lines.push(`Error: ${oneLine(message, ERROR_LIMIT)}`);
	}
	if (input.canvases.length)
		lines.push(
			`Canvases it showed (latest revision of each; read one with read_canvas, show it to the person with show_canvas):\n${input.canvases
				.map(threadCanvasText)
				.join("\n")}`,
		);
	return lines;
}
