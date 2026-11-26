/**
 * Y² must not re-send what the person already told a thread. The crew keeps
 * the person's last direct message to each thread (text and time) until Y²
 * next sends into it; message_thread checks it with these rules.
 */

/** How long a direct message of the person still counts as "just said". */
export const PERSON_MESSAGE_WINDOW_MS = 10 * 60_000;
/** Longest person message the crew keeps per thread, and quotes back to Y². */
export const PERSON_MESSAGE_KEEP = 400;
const QUOTE = 80;
/** Word overlap at or above which a text is the same instruction reworded. */
export const NEAR_DUPLICATE_SIMILARITY = 0.8;

const words = (text: string) =>
	text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);

/** Normalised word overlap, 0 to 1: shared words over the smaller text's words (Y²'s rewording is usually longer). */
export function textSimilarity(a: string, b: string) {
	const left = new Set(words(a));
	const right = new Set(words(b));
	// A one-liner of a few words shares words with anything: not a rewording.
	if (Math.min(left.size, right.size) < 4) return 0;
	let shared = 0;
	for (const word of left) if (right.has(word)) shared++;
	return shared / Math.min(left.size, right.size);
}

const quote = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > QUOTE ? `${flat.slice(0, QUOTE - 1)}…` : flat;
};

export type PersonMessageGuard =
	| { readonly kind: "ok" }
	| { readonly kind: "duplicate"; readonly notice: string }
	| { readonly kind: "needs-reason"; readonly notice: string };

/**
 * Whether Y² may send `text` to a thread the person messaged directly
 * `at` (null: they did not since Y²'s last send). A near-identical text is
 * refused outright; anything else needs `addsNewInformation` and a reason.
 */
export function guardAgainstResend(input: {
	readonly text: string;
	readonly personText: string | null | undefined;
	readonly personAt: number | null | undefined;
	readonly now: number;
	readonly addsNewInformation?: boolean;
	readonly reason?: string;
}): PersonMessageGuard {
	const { personText, personAt } = input;
	if (
		!personText ||
		!personAt ||
		input.now - personAt > PERSON_MESSAGE_WINDOW_MS
	)
		return { kind: "ok" };
	const said = quote(personText);
	if (textSimilarity(input.text, personText) >= NEAR_DUPLICATE_SIMILARITY)
		return {
			kind: "duplicate",
			notice: `Not sent: the person already told this thread this (“${said}”). Do not repeat or reword it. If you have a NEW fact it lacks, send only that fact in one line.`,
		};
	if (input.addsNewInformation && input.reason?.trim()) return { kind: "ok" };
	return {
		kind: "needs-reason",
		notice: `Not sent: the person already messaged this thread: “${said}”. Send only if you add new information: call again with addsNewInformation=true and reason (a few words), and put only the new fact in text.`,
	};
}
