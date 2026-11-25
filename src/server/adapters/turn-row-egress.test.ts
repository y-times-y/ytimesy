import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * Egress guard. A turn row (api_turn) and a chat row (agent_session) hold a
 * whole conversation: megabytes on a long chat (the Y² chat's turn row is
 * 8 MB). Supabase bills every byte a query returns, so a statement that
 * returns `*` or the `messages` / `items` columns of those tables on a hot
 * path costs the row's size on every call. On Nov 23-24 2026 the box turn
 * path read `select * from api_turn where id=$1 and lease_id=$2 ...` about
 * 3,000 times a day at about 2.6 MB each (production `db.egress_summary`),
 * and Supabase egress went from under 1 GB to 25 GB a day.
 *
 * This test reads the SQL in src/server and fails when a statement returns
 * `*`, or bare `messages` / `items`, from api_turn or agent_session unless it
 * is listed below with the reason it is acceptable. A new entry needs a
 * reviewer to say why the statement runs rarely, returns a delta, or never
 * leaves the database. An entry that no longer matches anything also fails,
 * so the list cannot rot.
 */

type Literal = { line: number; sql: string };

const ROOT = "src/server";

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return files(path);
		return path.endsWith(".ts") && !path.includes(".test.") ? [path] : [];
	});
}

/**
 * Every string and template literal of a TypeScript source, with `${...}`
 * replaced by `X` (or `STAR` when the expression can produce `"*"`). Nested
 * templates inside an expression are emitted as literals of their own.
 */
function literals(source: string): Literal[] {
	const found: Literal[] = [];
	const lineAt = (index: number) => source.slice(0, index).split("\n").length;

	function skipLineComment(from: number) {
		const end = source.indexOf("\n", from);
		return end < 0 ? source.length : end;
	}
	function skipBlockComment(from: number) {
		const end = source.indexOf("*/", from + 2);
		return end < 0 ? source.length : end + 2;
	}
	function readQuoted(from: number, quote: string): number {
		let i = from + 1;
		while (i < source.length && source[i] !== quote) {
			if (source[i] === "\\") i++;
			i++;
		}
		return i + 1;
	}
	function readDouble(from: number): number {
		const end = readQuoted(from, '"');
		found.push({ line: lineAt(from), sql: source.slice(from + 1, end - 1) });
		return end;
	}
	/** Skips a `${ ... }` expression; returns its end and its source. */
	function readExpression(from: number): { end: number; text: string } {
		let depth = 1;
		let i = from;
		while (i < source.length && depth > 0) {
			const c = source[i];
			if (c === "{") depth++;
			else if (c === "}") {
				depth--;
				if (depth === 0) break;
			} else if (c === '"' || c === "'") {
				i = readQuoted(i, c) - 1;
			} else if (c === "`") {
				i = readTemplate(i) - 1;
			} else if (c === "/" && source[i + 1] === "/") {
				i = skipLineComment(i) - 1;
			} else if (c === "/" && source[i + 1] === "*") {
				i = skipBlockComment(i) - 1;
			}
			i++;
		}
		return { end: i + 1, text: source.slice(from, i) };
	}
	function readTemplate(from: number): number {
		let i = from + 1;
		let sql = "";
		while (i < source.length && source[i] !== "`") {
			if (source[i] === "\\") {
				sql += source[i + 1] ?? "";
				i += 2;
				continue;
			}
			if (source[i] === "$" && source[i + 1] === "{") {
				const expression = readExpression(i + 2);
				sql += /"\*"/.test(expression.text) ? " STAR " : " X ";
				i = expression.end;
				continue;
			}
			sql += source[i];
			i++;
		}
		found.push({ line: lineAt(from), sql });
		return i + 1;
	}

	let index = 0;
	while (index < source.length) {
		const c = source[index];
		if (c === "/" && source[index + 1] === "/") index = skipLineComment(index);
		else if (c === "/" && source[index + 1] === "*")
			index = skipBlockComment(index);
		else if (c === '"') index = readDouble(index);
		else if (c === "'") index = readQuoted(index, "'");
		else if (c === "`") index = readTemplate(index);
		else index++;
	}
	return found;
}

const TABLE = "(?:api_turn|agent_session)";
const BARE_COLUMN =
	/(?:^|,)\s*(?:\w+\.)?(?:messages|items)(?:\s+as\s+\w+)?\s*(?=,|$)/;
const WRAPPED_COLUMN =
	/\b(?:then|else)\s+(?:\w+\.)?(?:messages|items)\b|\bcoalesce\(\s*(?:\w+\.)?(?:messages|items)\b/;

/** Function calls collapsed, so `jsonb_array_length(messages)` is not a column read. */
function withoutCalls(list: string) {
	let previous = "";
	let text = list;
	while (text !== previous) {
		previous = text;
		text = text.replace(/\b\w+\s*\([^()]*\)/g, "F");
	}
	return text;
}

function offences(raw: string): string[] {
	const sql = raw.replace(/\s+/g, " ").toLowerCase();
	if (!new RegExp(`\\b${TABLE}\\b`).test(sql)) return [];
	const found: string[] = [];
	const writes = new RegExp(`(?:update|insert\\s+into)\\s+${TABLE}\\b`).test(
		sql,
	);
	if (new RegExp(`select\\s+(?:\\w+\\.)?\\*\\s+from\\s+${TABLE}\\b`).test(sql))
		found.push("select *");
	if (writes && /returning\s+(?:(?:\w+\.)?\*|star)(?:\s|;|$|\))/.test(sql))
		found.push("returning *");
	for (const match of sql.matchAll(
		new RegExp(`select\\s+(?:distinct\\s+)?(.*?)\\s+from\\s+${TABLE}\\b`, "g"),
	)) {
		const list = match[1];
		if (BARE_COLUMN.test(withoutCalls(list)) || WRAPPED_COLUMN.test(list)) {
			found.push("select messages/items");
			break;
		}
	}
	if (writes)
		for (const match of sql.matchAll(
			/returning\s+(.*?)(?:\)\s*(?:select|update|insert|delete)|;|$)/g,
		)) {
			const list = match[1];
			if (BARE_COLUMN.test(withoutCalls(list)) || WRAPPED_COLUMN.test(list)) {
				found.push("returning messages/items");
				break;
			}
		}
	return found;
}

type Allowed = { file: string; contains: string; why: string };

/**
 * Each entry names a statement (a file and a snippet of its text) and why it
 * may return a whole turn or chat. An entry that matches nothing fails the test, so
 * a fixed statement's entry has to go with it.
 */
const ALLOWED: readonly Allowed[] = [
	{
		file: "src/server/adapters/api-turns.ts",
		contains: "select * from api_turn where id=$1 and lease_id=$2",
		why: "readRunningApiTurn, the box edge's loadOwned, now used by the history endpoint alone (its answer is the whole row, versioned by updated_at so an unchanged one is not sent again). Every other box endpoint, the port calls and the vm routes read readRunningApiTurnIdentity: this was 2.6 MB a call and 4.2 GB on 2026-11-23 (turn-box-routes.test.ts pins it).",
	},
	{
		file: "src/server/adapters/api-turns.ts",
		contains: "returning star ; commit",
		why: 'claimApiTurn returns `*` for the in-process node worker, local runs and turn-start, which run the turn from the claimed row. The box claim (shape "box") has its own slim columns and a counted history size.',
	},
	{
		file: "src/server/adapters/api-turns.ts",
		contains: "(select b.messages from api_turn b where b.id=$16::uuid)",
		why: "A new turn copies its base turn's messages inside the database; nothing is returned to the caller.",
	},
	{
		file: "src/server/adapters/api-turns.ts",
		contains: "coalesce((select a.items from agent_session a where a.id=$2)",
		why: "A new turn seeds its items from the chat inside the database; nothing is returned to the caller.",
	},
	{
		file: "src/server/adapters/api-turns.ts",
		contains:
			"select messages,model_id,connection_revision,state,failover from api_turn",
		why: "previousTurnMessages: the settled previous turn's history, read once when a send continues a chat without a cached copy (a recovery path, not per step). Watch it with db.egress_summary: a Y² send reads up to 8 MB here.",
	},
	{
		file: "src/server/adapters/active-turn-history.ts",
		contains: "from api_turn t join agent_session s on s.id=t.session_id",
		why: "The chat object's history load: only the messages after the copy it already holds (base_count), the whole array only on a cache miss, items only from the anchor onward.",
	},
	{
		file: "src/server/adapters/turn-history-seed.ts",
		contains: "from api_turn t join agent_session s on s.id=t.session_id",
		why: "The same delta read for the history cache seed: messages after the cached copy, changed items by revision.",
	},
	{
		file: "src/server/edge/executor.ts",
		contains: "select t.messages,case when jsonb_typeof(t.items)='array'",
		why: "The chat object loads its turn's history once, when the turn starts on the object (not per step). Egress here repeats when the object restarts mid-turn (a long chat reset it 38 times an hour before Nov 23): watch it.",
	},
	{
		file: "src/server/adapters/conversation-recovery.ts",
		contains: "insert into agent_task_command_receipt",
		why: "insert ... select copies the transcript inside the database; nothing is returned to the caller.",
	},
	{
		file: "src/server/services/conversation-recovery.ts",
		contains: "insert into agent_task_command_receipt",
		why: "insert ... select copies the transcript inside the database; nothing is returned to the caller.",
	},
	{
		file: "src/server/services/subagent-turn-recovery.ts",
		contains: "select l.* from api_turn l",
		why: "A lateral subquery of the child's latest turn; the outer select names only id, session_id, state and the items it needs. Runs in the reconcile sweep, limit 32, only for settled children whose report is missing.",
	},
	{
		file: "src/server/adapters/agent-sessions.ts",
		contains: "applyBackgroundCommandExits",
		why: "Rewrites a chat's legacy `items` column inside the database; `returning s.items` feeds an exists() check in the same statement and is not returned.",
	},
	{
		file: "src/server/adapters/attempt-loop-store.ts",
		contains: "select turn_status, items from agent_session",
		why: "Legacy `agent_session.items` read of one subagent's status for a loop; only for a child that never reported. Confirm the column is empty after the agent_session_item migration, then switch to projected item reads.",
	},
	{
		file: "src/server/adapters/memory-settings.ts",
		contains: "s.items,s.updated_at from agent_session s",
		why: "Memory settings: one chat's legacy items, read when the user opens a memory view (not per turn). Confirm the column is empty after the migration.",
	},
	{
		file: "src/server/adapters/memory-settings.ts",
		contains: "select items,turn_status from agent_session",
		why: "Saves memory lines into one chat's legacy items (up to 3 attempts), once per user action. Confirm the column is empty after the migration.",
	},
	{
		file: "src/server/adapters/subagents.ts",
		contains: "select items from agent_session where id=$1",
		why: "Peer message append to a chat's legacy items (up to 5 attempts), once per agent message. Confirm the column is empty after the migration.",
	},
	{
		file: "src/server/adapters/interruption-events.ts",
		contains: "select items from agent_session where id=$1 and user_id=$2",
		why: "The interruption canary reads one chat's items to check a run; the canary is off by default and runs a few times a day.",
	},
];

type Offender = { file: string; line: number; kinds: string[]; sql: string };

function offenders(): Offender[] {
	const found: Offender[] = [];
	for (const file of files(ROOT)) {
		const source = readFileSync(file, "utf8");
		for (const literal of literals(source)) {
			const kinds = offences(literal.sql);
			if (kinds.length)
				found.push({
					file,
					line: literal.line,
					kinds,
					sql: literal.sql.replace(/\s+/g, " ").trim(),
				});
		}
	}
	return found;
}

const allowedBy = (offender: Offender) =>
	ALLOWED.find(
		(entry) =>
			entry.file === offender.file &&
			offender.sql.toLowerCase().includes(entry.contains.toLowerCase()),
	);

it("no hot path returns a whole turn or chat row unless it is listed with a reason", () => {
	const unlisted = offenders()
		.filter((offender) => !allowedBy(offender))
		.map(
			(offender) =>
				`${offender.file}:${offender.line} ${offender.kinds.join(", ")}: ${offender.sql.slice(0, 100)}`,
		);
	expect(unlisted).toEqual([]);
});

it("every allow-list entry still matches a statement and gives a reason", () => {
	const all = offenders();
	const stale = ALLOWED.filter(
		(entry) =>
			!entry.why.trim() ||
			!all.some(
				(offender) =>
					offender.file === entry.file &&
					offender.sql.toLowerCase().includes(entry.contains.toLowerCase()),
			),
	).map((entry) => `${entry.file}: ${entry.contains}`);
	expect(stale).toEqual([]);
});

it("the scanner finds what it is meant to find", () => {
	const sql = (text: string) => offences(text);
	expect(sql("select * from api_turn where id=$1")).toContain("select *");
	expect(sql("select t.* from api_turn t where id=$1")).toContain("select *");
	expect(sql("select messages,state from api_turn where id=$1")).toContain(
		"select messages/items",
	);
	expect(
		sql("select jsonb_array_length(messages) as count from api_turn"),
	).toEqual([]);
	expect(
		sql("update api_turn set state='x' where id=$1 returning *"),
	).toContain("returning *");
	expect(
		sql("update api_turn set state='x' where id=$1 returning id,state"),
	).toEqual([]);
	expect(sql("select id,title from agent_session where id=$1")).toEqual([]);
	// A template expression that can yield "*" counts as a star.
	const expression = ["$", "{shape ? COLUMNS : ", '"*"', "}"].join("");
	const found = literals(
		`const a = \`update api_turn set x=1 returning ${expression}\`;`,
	);
	expect(offences(found[0].sql)).toContain("returning *");
});
