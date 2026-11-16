import { startsTurn } from "#/domain/child-task-activity";
import { jsonbText } from "#/domain/jsonb";
import type { SessionItem } from "#/domain/session-item";

/** Each page is independently parseable; starting a turn never joins old pages. */
const PAGE_CHARACTERS = 500_000;

export class TurnItemPages {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`create table if not exists turn_item_page(
		 turn_id text not null,page integer not null,data text not null,
		 primary key(turn_id,page))`);
		sql.exec(`create table if not exists turn_item_anchor(
		 turn_id text not null,item_id text not null,page integer not null,offset integer not null,
		 primary key(turn_id,item_id))`);
	}

	write(turnId: string, items: readonly SessionItem[]) {
		this.sql.exec("delete from turn_item_anchor where turn_id=?", turnId);
		let page = 0;
		let pieces: string[] = [];
		let characters = 2;
		const flush = () => {
			this.sql.exec(
				`insert into turn_item_page values(?,?,?) on conflict(turn_id,page)
				 do update set data=excluded.data where data<>excluded.data`,
				turnId,
				page++,
				`[${pieces.join(",")}]`,
			);
			pieces = [];
			characters = 2;
		};
		for (const item of items) {
			const text = jsonbText(item);
			if (text.length + 2 > PAGE_CHARACTERS)
				throw new Error("A transcript item exceeds the local cache page size.");
			if (pieces.length && characters + text.length + 1 > PAGE_CHARACTERS)
				flush();
			if (startsTurn(item))
				this.sql.exec(
					"insert into turn_item_anchor values(?,?,?,?)",
					turnId,
					item.id,
					page,
					pieces.length,
				);
			pieces.push(text);
			characters += text.length + 1;
		}
		flush();
		this.sql.exec(
			"delete from turn_item_page where turn_id=? and page>=?",
			turnId,
			page,
		);
	}

	/** Null for a cache written before independent pages, or a missing anchor. */
	readFrom(turnId: string, from: string): SessionItem[] | null {
		const anchor = this.sql
			.exec<{ page: number; offset: number }>(
				"select page,offset from turn_item_anchor where turn_id=? and item_id=?",
				turnId,
				from,
			)
			.toArray()[0];
		if (!anchor) return null;
		const items = this.readPages(turnId, anchor.page, anchor.offset);
		return items?.[0]?.id === from ? items : null;
	}

	readAll(turnId: string): SessionItem[] | null {
		return this.readPages(turnId, 0, 0);
	}

	private readPages(
		turnId: string,
		firstPage: number,
		offset: number,
	): SessionItem[] | null {
		const rows = this.sql
			.exec<{ data: string }>(
				"select data from turn_item_page where turn_id=? and page>=? order by page",
				turnId,
				firstPage,
			)
			.toArray();
		if (!rows.length) return null;
		const items: SessionItem[] = [];
		for (let index = 0; index < rows.length; index++) {
			const page = JSON.parse(rows[index].data) as SessionItem[];
			items.push(...(index === 0 ? page.slice(offset) : page));
		}
		return items;
	}

	clear(turnId?: string) {
		for (const table of ["turn_item_page", "turn_item_anchor"])
			this.sql.exec(
				`delete from ${table}${turnId === undefined ? "" : " where turn_id=?"}`,
				...(turnId === undefined ? [] : [turnId]),
			);
	}

	keep(turnId: string) {
		this.sql.exec("delete from turn_item_page where turn_id<>?", turnId);
		this.sql.exec("delete from turn_item_anchor where turn_id<>?", turnId);
	}
}
