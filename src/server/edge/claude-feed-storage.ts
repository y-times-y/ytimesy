import {
	type ClaudeFeedBatch,
	type ClaudeFeedState,
	feedBatchDecision,
	feedEntriesWithEnds,
	isStaleFeedRun,
} from "../../domain/claude-feed";

/**
 * The chat object's copy of its Claude Code run's output (claude-feed.ts):
 * lines in offset order, and per run what has arrived (received_to) and
 * what a committed step has read (consumed_to). Only the turn's current
 * run is kept; read lines are deleted once a step past them commits.
 */
export class SqliteClaudeFeed {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`create table if not exists claude_feed(
			turn text not null, run integer not null, offset integer not null,
			next integer not null, line text not null, primary key(turn,run,offset))`);
		sql.exec(`create table if not exists claude_feed_state(
			turn text not null, run integer not null, received_to integer not null,
			consumed_to integer not null, last_seen integer not null, exit_status text,
			primary key(turn,run))`);
	}
	private currentRun(turn: string) {
		return (
			this.sql
				.exec<{ run: number | null }>(
					"select max(run) as run from claude_feed_state where turn=?",
					turn,
				)
				.toArray()[0]?.run ?? null
		);
	}
	state(turn: string, run: number): ClaudeFeedState | null {
		return (
			this.sql
				.exec<{
					run: number;
					receivedTo: number;
					consumedTo: number;
					lastSeen: number;
					exitStatus: string | null;
				}>(
					`select run,received_to as receivedTo,consumed_to as consumedTo,
					 last_seen as lastSeen,exit_status as exitStatus
					 from claude_feed_state where turn=? and run=?`,
					turn,
					run,
				)
				.toArray()[0] ?? null
		);
	}
	/** Makes `run` the turn's current run (dropping older ones); null for an older run. */
	private adopt(turn: string, run: number) {
		if (isStaleFeedRun(this.currentRun(turn), run)) return false;
		this.sql.exec("delete from claude_feed where turn=? and run<?", turn, run);
		this.sql.exec(
			"delete from claude_feed_state where turn=? and run<?",
			turn,
			run,
		);
		this.sql.exec(
			`insert into claude_feed_state(turn,run,received_to,consumed_to,last_seen)
			 values(?,?,0,0,0) on conflict(turn,run) do nothing`,
			turn,
			run,
		);
		return true;
	}
	/** A runner said hello: what the object holds of its run, or null (stop: an old run). */
	hello(turn: string, run: number, now: number) {
		if (!this.adopt(turn, run)) return null;
		this.touch(turn, run, now);
		return this.state(turn, run)?.receivedTo ?? 0;
	}
	touch(turn: string, run: number, now: number) {
		this.sql.exec(
			"update claude_feed_state set last_seen=? where turn=? and run=?",
			now,
			turn,
			run,
		);
	}
	/** Stores a batch in order, or says which offset to resend from; null: not the current run. */
	accept(turn: string, run: number, batch: ClaudeFeedBatch, now: number) {
		const state = this.state(turn, run);
		if (!state || isStaleFeedRun(this.currentRun(turn), run)) return null;
		const decision = feedBatchDecision(state.receivedTo, batch);
		if (decision.kind === "accept") {
			for (const entry of feedEntriesWithEnds(batch))
				this.sql.exec(
					"insert or ignore into claude_feed(turn,run,offset,next,line) values(?,?,?,?,?)",
					turn,
					run,
					entry.offset,
					entry.next,
					entry.line,
				);
			this.sql.exec(
				"update claude_feed_state set received_to=? where turn=? and run=?",
				decision.receivedTo,
				turn,
				run,
			);
		}
		this.touch(turn, run, now);
		return decision;
	}
	exit(turn: string, run: number, status: string, now: number) {
		this.sql.exec(
			"update claude_feed_state set exit_status=?,last_seen=? where turn=? and run=?",
			status,
			now,
			turn,
			run,
		);
	}
	/** Up to `limit` lines from `from` that have arrived, in offset order. */
	lines(turn: string, run: number, from: number, limit: number) {
		return this.sql
			.exec<{ offset: number; next: number; line: string }>(
				"select offset,next,line from claude_feed where turn=? and run=? and offset>=? order by offset limit ?",
				turn,
				run,
				from,
				limit,
			)
			.toArray();
	}
	/**
	 * A committed step read the run through `to` (in either mode): later
	 * steps start there, and the lines before it are no longer kept.
	 */
	commitConsumed(turn: string, run: number, to: number) {
		if (!this.adopt(turn, run)) return;
		this.sql.exec(
			"update claude_feed_state set consumed_to=max(consumed_to,?) where turn=? and run=?",
			to,
			turn,
			run,
		);
		this.sql.exec(
			"delete from claude_feed where turn=? and run=? and next<=?",
			turn,
			run,
			to,
		);
	}
	clearTurn(turn: string) {
		this.sql.exec("delete from claude_feed where turn=?", turn);
		this.sql.exec("delete from claude_feed_state where turn=?", turn);
	}
}
