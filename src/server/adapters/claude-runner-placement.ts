import { AsyncLocalStorage } from "node:async_hooks";
import type { ClaudeRunnerBox } from "#/domain/claude-runner";

/** Only the conversation owner supplies this synchronous, durable placement store. */
const placement = new AsyncLocalStorage<(candidate: string) => string>();

export function withClaudeRunnerPlacement<T>(
	assign: (candidate: string) => string,
	run: () => Promise<T>,
) {
	return placement.run(assign, run);
}

/** The configured list proposes an initial host; it must never relocate a live session. */
export function pinnedClaudeRunner(
	candidate: ClaudeRunnerBox,
): ClaudeRunnerBox {
	const assign = placement.getStore();
	if (!assign)
		throw new Error("The chat's durable runner placement is unavailable.");
	return { ...candidate, baseUrl: assign(candidate.baseUrl) };
}

/** A host survives step resets, new turns and changes to the configured pool. No secret is stored. */
export class ClaudeRunnerPlacement {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(
			"create table if not exists claude_runner_placement(id integer primary key check(id=1),base_url text not null)",
		);
	}

	assign(candidate: string): string {
		const url = new URL(candidate);
		if (url.protocol !== "https:" || url.origin !== candidate)
			throw new Error("Invalid runner origin.");
		this.sql.exec(
			"insert or ignore into claude_runner_placement(id,base_url) values(1,?)",
			candidate,
		);
		const row = this.sql
			.exec<{ base_url: string }>(
				"select base_url from claude_runner_placement where id=1",
			)
			.toArray()[0];
		if (!row) throw new Error("Runner placement was not saved.");
		return row.base_url;
	}
}
