import type { ModelMessage } from "ai";
import type { SessionItem } from "../../domain/session-item";

/** Stays well under the 2 MB limit on one SQLite value in a Durable Object. */
const CHUNK_CHARACTERS = 500_000;

type History = { messages: ModelMessage[]; items: SessionItem[] };

/**
 * The chat's local copy of its running turn's history, tagged with the
 * api_turn.updated_at version Postgres reported for the write that produced it.
 * A matching version means Postgres holds exactly this; anything else means
 * someone else wrote the turn and it must be read again.
 */
export class TurnHistoryCache {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`create table if not exists turn_history(
			turn_id text not null, part text not null check(part in ('messages','items')),
			chunk integer not null, data text not null, primary key(turn_id,part,chunk))`);
		sql.exec(`create table if not exists turn_history_version(
			turn_id text primary key, version text not null)`);
		// The chat's transcript revision (agent_session.items_rev) each cached
		// items copy matches, and the copy kept across turns (keepChatCopy).
		sql.exec(`create table if not exists turn_history_items_rev(
			turn_id text primary key, items_rev text not null)`);
		sql.exec(`create table if not exists chat_items_copy(
			id integer primary key check(id=1), turn_id text not null, items_rev text not null)`);
		// The last turn's model history as of its row version (api_turn.updated_at),
		// kept across turns: the next turn continuing it reads only what follows.
		sql.exec(`create table if not exists chat_messages_copy(
			id integer primary key check(id=1), turn_id text not null, version text not null)`);
	}

	/** The last turn's history at row version `version` (kept when it ended). */
	chatMessagesCopy(): {
		turnId: string;
		version: string;
		messages: ModelMessage[];
	} | null {
		const copy = this.sql
			.exec<{ turn_id: string; version: string }>(
				"select turn_id,version from chat_messages_copy where id=1",
			)
			.toArray()[0];
		if (!copy) return null;
		const messages = this.part(copy.turn_id, "messages");
		return messages
			? {
					turnId: copy.turn_id,
					version: copy.version,
					messages: JSON.parse(messages),
				}
			: null;
	}

	/**
	 * The chat's transcript as of revision `itemsRev` (the last turn's copy,
	 * kept when it ended): a new turn reads only the rows written after it.
	 */
	chatCopy(): { itemsRev: string; items: SessionItem[] } | null {
		const copy = this.sql
			.exec<{ turn_id: string; items_rev: string }>(
				"select turn_id,items_rev from chat_items_copy where id=1",
			)
			.toArray()[0];
		if (!copy) return null;
		const items = this.part(copy.turn_id, "items");
		return items
			? { itemsRev: copy.items_rev, items: JSON.parse(items) }
			: null;
	}

	/**
	 * At a turn's end: keep the items of the turn copy whose transcript
	 * revision is known (the latest), drop everything else.
	 */
	keepChatCopy() {
		const kept = this.sql
			.exec<{ turn_id: string; items_rev: string }>(
				"select turn_id,items_rev from turn_history_items_rev order by cast(items_rev as integer) desc limit 1",
			)
			.toArray()[0];
		if (!kept) {
			this.clear();
			return;
		}
		// Its messages stay too when their version is known (its last write
		// was mirrored here): they are what Postgres holds at that version.
		const version = this.version(kept.turn_id);
		const keepMessages =
			version !== undefined &&
			this.sql
				.exec(
					"select 1 from turn_history where turn_id=? and part='messages' limit 1",
					kept.turn_id,
				)
				.toArray().length > 0;
		this.sql.exec(
			keepMessages
				? "delete from turn_history where turn_id<>?"
				: "delete from turn_history where turn_id<>? or part<>'items'",
			kept.turn_id,
		);
		this.sql.exec("delete from turn_history_version");
		if (keepMessages)
			this.sql.exec(
				"insert into chat_messages_copy values(1,?,?) on conflict(id) do update set turn_id=excluded.turn_id,version=excluded.version",
				kept.turn_id,
				version,
			);
		else this.sql.exec("delete from chat_messages_copy");
		this.sql.exec(
			"delete from turn_history_items_rev where turn_id<>?",
			kept.turn_id,
		);
		this.sql.exec(
			"insert into chat_items_copy values(1,?,?) on conflict(id) do update set turn_id=excluded.turn_id,items_rev=excluded.items_rev",
			kept.turn_id,
			kept.items_rev,
		);
	}

	read(turnId: string, version: string): History | null {
		if (this.version(turnId) !== version) return null;
		const messages = this.part(turnId, "messages");
		const items = this.part(turnId, "items");
		return messages && items
			? { messages: JSON.parse(messages), items: JSON.parse(items) }
			: null;
	}

	/**
	 * A write without messages keeps the cached ones; it only applies on top of a full copy.
	 * With `previous` (the row's version just before this write), it applies
	 * only on top of exactly that version: if another writer changed the turn
	 * in between, the copy no longer matches Postgres and is dropped.
	 */
	write(
		turnId: string,
		version: string,
		history: { messages?: ModelMessage[]; items: readonly SessionItem[] },
		previous?: string,
		/** The chat's transcript revision this write left (agent_session.items_rev). */
		itemsRev?: string,
	) {
		if (previous !== undefined && this.version(turnId) !== previous) {
			this.clear(turnId);
			return;
		}
		if (
			!history.messages &&
			!this.sql
				.exec(
					"select 1 from turn_history where turn_id=? and part='messages' limit 1",
					turnId,
				)
				.toArray().length
		) {
			this.clear(turnId);
			return;
		}
		if (history.messages)
			this.store(turnId, "messages", JSON.stringify(history.messages));
		this.store(turnId, "items", JSON.stringify(history.items));
		this.sql.exec(
			"insert into turn_history_version values(?,?) on conflict(turn_id) do update set version=excluded.version",
			turnId,
			version,
		);
		// Unknown revision: this copy may not seed a later turn.
		if (itemsRev === undefined)
			this.sql.exec(
				"delete from turn_history_items_rev where turn_id=?",
				turnId,
			);
		else
			this.sql.exec(
				"insert into turn_history_items_rev values(?,?) on conflict(turn_id) do update set items_rev=excluded.items_rev",
				turnId,
				itemsRev,
			);
	}

	clear(turnId?: string) {
		if (turnId === undefined) {
			this.sql.exec("delete from turn_history");
			this.sql.exec("delete from turn_history_version");
			this.sql.exec("delete from turn_history_items_rev");
			this.sql.exec("delete from chat_items_copy");
			this.sql.exec("delete from chat_messages_copy");
			return;
		}
		this.sql.exec("delete from turn_history where turn_id=?", turnId);
		this.sql.exec("delete from turn_history_version where turn_id=?", turnId);
		this.sql.exec("delete from turn_history_items_rev where turn_id=?", turnId);
		this.sql.exec("delete from chat_items_copy where turn_id=?", turnId);
		this.sql.exec("delete from chat_messages_copy where turn_id=?", turnId);
	}

	private version(turnId: string) {
		return this.sql
			.exec<{ version: string }>(
				"select version from turn_history_version where turn_id=?",
				turnId,
			)
			.toArray()[0]?.version;
	}

	private part(turnId: string, part: "messages" | "items") {
		const chunks = this.sql
			.exec<{ data: string }>(
				"select data from turn_history where turn_id=? and part=? order by chunk",
				turnId,
				part,
			)
			.toArray();
		return chunks.length ? chunks.map((chunk) => chunk.data).join("") : null;
	}

	private store(turnId: string, part: "messages" | "items", value: string) {
		this.sql.exec(
			"delete from turn_history where turn_id=? and part=?",
			turnId,
			part,
		);
		for (let offset = 0, chunk = 0; offset < value.length; chunk++) {
			this.sql.exec(
				"insert into turn_history values(?,?,?,?)",
				turnId,
				part,
				chunk,
				value.slice(offset, offset + CHUNK_CHARACTERS),
			);
			offset += CHUNK_CHARACTERS;
		}
	}
}

/**
 * The chat's transcript rebuilt from a copy at revision V, the item count
 * now, and every row written after V (agent_session_item.rev > V): rows not
 * written since keep the copy's item. Null when they do not cover every
 * position (the copy is not a prefix the database still holds).
 */
export function seededTranscript(
	copy: readonly SessionItem[],
	count: number,
	changed: readonly { readonly position: number; readonly item: SessionItem }[],
): SessionItem[] | null {
	if (!Number.isInteger(count) || count < 0) return null;
	const items: (SessionItem | undefined)[] = copy.slice(0, count);
	items.length = count;
	for (const row of changed) {
		if (
			!Number.isInteger(row.position) ||
			row.position < 0 ||
			row.position >= count
		)
			return null;
		items[row.position] = row.item;
	}
	for (let index = 0; index < count; index++)
		if (items[index] === undefined) return null;
	return items as SessionItem[];
}
