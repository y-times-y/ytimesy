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
	}

	read(turnId: string, version: string): History | null {
		const current = this.sql
			.exec<{ version: string }>(
				"select version from turn_history_version where turn_id=?",
				turnId,
			)
			.toArray()[0];
		if (current?.version !== version) return null;
		const messages = this.part(turnId, "messages");
		const items = this.part(turnId, "items");
		return messages && items
			? { messages: JSON.parse(messages), items: JSON.parse(items) }
			: null;
	}

	/** A write without messages keeps the cached ones; it only applies on top of a full copy. */
	write(
		turnId: string,
		version: string,
		history: { messages?: ModelMessage[]; items: readonly SessionItem[] },
	) {
		if (!history.messages && !this.part(turnId, "messages")) {
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
	}

	clear(turnId?: string) {
		if (turnId === undefined) {
			this.sql.exec("delete from turn_history");
			this.sql.exec("delete from turn_history_version");
			return;
		}
		this.sql.exec("delete from turn_history where turn_id=?", turnId);
		this.sql.exec("delete from turn_history_version where turn_id=?", turnId);
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
