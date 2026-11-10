import { jsonbText } from "#/domain/jsonb";
import type { SessionItem } from "#/domain/session-item";

/**
 * Where a durable-object turn's items live. The chat's `agent_session.items`
 * is the only copy of the history; the turn row keeps `{"from": <id>}`, the
 * first item of its own turn (its user message). Older rows hold the full
 * items array and are still read and written as before, so a turn started
 * by the previous deploy finishes in its own shape.
 */
export function lastUserMessageIndex(items: readonly SessionItem[]) {
	let index = items.length - 1;
	while (index >= 0 && items[index].kind !== "userMessage") index--;
	return index;
}

export function newTurnItemsColumn(
	items: readonly SessionItem[],
): string | null {
	const last = lastUserMessageIndex(items);
	return last >= 0 ? JSON.stringify({ from: items[last].id }) : null;
}

/** A turn row's items as an array of this turn's items, in either shape. */
export function turnRowItems(raw: unknown, sessionItems: unknown): unknown {
	return Array.isArray(raw) || raw === null || raw === undefined
		? raw
		: sessionItems;
}

export type ItemsWrite = {
	/** `set` expression for api_turn.items. */
	apiTurn: string;
	/** `set` expression for agent_session.items. */
	session: string;
	/** Value of the parameter at `itemsParam`. */
	itemsText: string;
	/** Parameters after `itemsParam`, in order. */
	extra: string[];
	/** Serialized bytes sent for the items. */
	bytes: number;
};

/**
 * One turn write's items. A turn in the new shape sends only its own items
 * and the database keeps the chat's earlier ones in place (appending in SQL);
 * when an earlier item changed in memory, or the turn's first item is gone,
 * the full list is sent instead. A legacy turn writes the full list to both.
 */
export function planItemsWrite(
	turn: { items: readonly SessionItem[]; items_from?: string },
	items: readonly SessionItem[],
	itemsParam: number,
	sessionColumn: string,
): ItemsWrite {
	const param = `$${itemsParam}`;
	const full = () => {
		const itemsText = jsonbText(items);
		return { itemsText, bytes: itemsText.length };
	};
	const from = turn.items_from;
	if (from === undefined)
		return {
			apiTurn: param,
			session: param,
			extra: [],
			...full(),
		};
	const start = items.findIndex((item) => item.id === from);
	let unchanged = start >= 0;
	for (let index = 0; unchanged && index < start; index++)
		unchanged = turn.items[index] === items[index];
	if (!unchanged)
		return { apiTurn: "items", session: param, extra: [], ...full() };
	const fromParam = `$${itemsParam + 1}`;
	const itemsText = jsonbText(items.slice(start));
	return {
		apiTurn: "items",
		session: `(select coalesce(jsonb_agg(e order by o),'[]'::jsonb) from jsonb_array_elements(${sessionColumn}) with ordinality x(e,o)
		 where o < coalesce((select y.o from jsonb_array_elements(${sessionColumn}) with ordinality y(e,o) where y.e->>'id'=${fromParam}),jsonb_array_length(${sessionColumn})+1)) || ${param}::jsonb`,
		itemsText,
		extra: [from],
		bytes: itemsText.length,
	};
}
