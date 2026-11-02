import type { EvidenceRecord } from "#/domain/pr-evidence";
import type { SessionItem } from "#/domain/session-item";

/**
 * Where each capture sits in the chat. An agent capture whose tool call is
 * loaded sits right after that call. Others sit after the last item of the
 * turn they were captured for (the latest user message sent before the
 * capture was recorded). Captures without such a turn go at the end.
 */
export function evidenceAnchors(
	visible: readonly SessionItem[],
	evidence: readonly EvidenceRecord[],
) {
	const turns: { startedAt: number; lastItemId: string }[] = [];
	for (const item of visible) {
		if (item.kind === "userMessage" && item.timing?.startedAt !== undefined)
			turns.push({ startedAt: item.timing.startedAt, lastItemId: item.id });
		else if (turns.length) turns[turns.length - 1].lastItemId = item.id;
	}
	const anchored = new Map<string, EvidenceRecord[]>();
	const trailing: EvidenceRecord[] = [];
	const loaded = new Set<string>(visible.map((item) => item.id));
	for (const record of evidence) {
		if (record.itemId && loaded.has(record.itemId)) {
			anchored.set(record.itemId, [
				...(anchored.get(record.itemId) ?? []),
				record,
			]);
			continue;
		}
		const at = Date.parse(record.createdAt);
		let turn: (typeof turns)[number] | undefined;
		for (const candidate of turns)
			if (candidate.startedAt <= at) turn = candidate;
		if (!turn || turn === turns.at(-1)) {
			trailing.push(record);
			continue;
		}
		anchored.set(turn.lastItemId, [
			...(anchored.get(turn.lastItemId) ?? []),
			record,
		]);
	}
	return { anchored, trailing };
}
