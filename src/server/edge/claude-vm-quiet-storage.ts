import type { ParkedVmQuiet } from "../../domain/claude-parked-turn";

/**
 * The chat object's record of its Claude Code turn's VM quiet
 * (claude-parked-turn.ts), in its own storage: a parked object hibernates
 * between the step that noted the quiet and the wake that checks the VM,
 * and a VM paused while parked must still be resumed by a later step.
 */
export class SqliteClaudeVmQuiet {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`create table if not exists claude_vm_quiet(
			id integer primary key check(id=1), turn_id text not null,
			user_id text not null, vm text not null, quiet_since integer,
			paused_at integer)`);
	}
	read(): ParkedVmQuiet | null {
		return (
			this.sql
				.exec<ParkedVmQuiet>(
					`select turn_id as turnId,user_id as userId,vm,
					 quiet_since as quietSince,paused_at as pausedAt from claude_vm_quiet`,
				)
				.toArray()[0] ?? null
		);
	}
	write(quiet: ParkedVmQuiet | null) {
		if (!quiet) {
			this.sql.exec("delete from claude_vm_quiet");
			return;
		}
		this.sql.exec(
			`insert into claude_vm_quiet(id,turn_id,user_id,vm,quiet_since,paused_at)
			 values(1,?,?,?,?,?) on conflict(id) do update set turn_id=excluded.turn_id,
			 user_id=excluded.user_id,vm=excluded.vm,quiet_since=excluded.quiet_since,
			 paused_at=excluded.paused_at`,
			quiet.turnId,
			quiet.userId,
			quiet.vm,
			quiet.quietSince,
			quiet.pausedAt,
		);
	}
	/** The VM was paused for thinking at `at`. */
	markPaused(turnId: string, at: number) {
		this.sql.exec(
			"update claude_vm_quiet set paused_at=? where turn_id=?",
			at,
			turnId,
		);
	}
}
