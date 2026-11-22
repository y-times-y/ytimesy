import { z } from "zod";
import type { ClaudeCodeGrant } from "../../domain/claude-code-grant";
import type {
	McpCallResult,
	McpToolDefinition,
} from "../../domain/claude-code-mcp";
import { CLAUDE_CODE_PROXY_PREFIX } from "../../domain/claude-code-proxy";
import type { TurnBoxEdgeSocketMessage } from "../../domain/turn-box-protocol";

/**
 * The MCP bridge of a Claude Code turn whose step runs on a turn runner box
 * (docs/turn-runner-boxes.md, "Claude Code on a box"). The run's CLI calls
 * the edge (/claude-code/mcp) with a grant marked for a box; a stateless
 * edge request holds that call while the box runs the tool. The chat's
 * Durable Object only passes messages between two hibernatable sockets:
 * the edge request's (one per call, tagged with the call's id) and the
 * box's own turn socket. It never waits on anything, so it bills no
 * duration while the tool runs.
 *
 * A call stays stored until the box acks it and is sent again whenever the
 * box's socket talks (or reconnects); the box runs each id once. Its answer
 * goes back to the call's socket, if that is still open.
 */
export const CLAUDE_RELAY_CALL_PATH = `${CLAUDE_CODE_PROXY_PREFIX}/relay-call`;
/** The tag of a relayed call's socket in the chat's object (with `ccr:<id>`). */
export const CLAUDE_RELAY_CALL_TAG = "claude-relay-call";
export const claudeRelayCallTag = (id: string) => `ccr:${id}`;
/** A stored call older than this is dropped (its edge request gave up long ago). */
const CALL_RETENTION_MS = 3 * 60 * 60_000;
/** An unacked call is sent again at most this often. */
const RESEND_EVERY_MS = 5_000;

export const relayCallMessage = z.object({
	t: z.literal("call"),
	name: z.string().min(1).max(256),
	args: z.record(z.string(), z.unknown()),
	invocationId: z.string().max(256).optional(),
	timeoutMs: z.number().int().positive(),
	graceMs: z.number().int().nonnegative(),
});
export type RelayCallMessage = z.infer<typeof relayCallMessage>;

const relayReplyMessage = z.object({
	t: z.literal("reply"),
	reply: z.object({
		text: z.string(),
		isError: z.boolean(),
		content: z.array(z.unknown()).optional(),
	}),
});

type Sql = {
	exec(
		query: string,
		...bindings: (string | number | null)[]
	): { toArray(): Record<string, unknown>[] };
};
type Socket = {
	send(data: string): void;
	close(code?: number, reason?: string): void;
};

/** The chat object's side: the stored calls and tools, and where each message goes. */
export class ClaudeRelay {
	constructor(
		private readonly sql: Sql,
		private readonly sockets: {
			/** The box's turn socket(s) for this turn. */
			readonly box: (turnId: string) => readonly Socket[];
			/** The open edge request socket of one call. */
			readonly call: (id: string) => readonly Socket[];
		},
		private readonly now: () => number = Date.now,
	) {
		sql.exec(
			"create table if not exists claude_relay_call(id text primary key,turn_id text not null,message text not null,acked integer not null default 0,sent_at integer not null default 0,created_at integer not null)",
		);
		sql.exec(
			"create table if not exists claude_relay_tools(turn_id text primary key,definitions text not null,at integer not null)",
		);
		// An answer that came while its call's socket was gone (2026-11-22).
		try {
			sql.exec("alter table claude_relay_call add column reply text");
		} catch {}
	}

	/** A call arrived on its edge socket: kept and sent to the box. */
	call(turnId: string, id: string, message: RelayCallMessage) {
		const at = this.now();
		this.sql.exec(
			"delete from claude_relay_call where created_at<?",
			at - CALL_RETENTION_MS,
		);
		const { t: _t, ...call } = message;
		this.sql.exec(
			"insert or ignore into claude_relay_call(id,turn_id,message,created_at) values(?,?,?,?)",
			id,
			turnId,
			JSON.stringify({ t: "claude-call", id, ...call }),
			at,
		);
		// The same call again (its edge request reconnected): an answer kept
		// meanwhile goes to it now; one still running is waited for.
		const kept = this.sql
			.exec(
				"select reply from claude_relay_call where id=? and reply is not null",
				id,
			)
			.toArray()[0] as { reply: string } | undefined;
		if (kept) {
			this.reply(id, JSON.parse(kept.reply) as McpCallResult);
			return;
		}
		this.deliver(turnId, true);
	}

	/** The call's edge request went away: a call the box has not taken is dropped. */
	callClosed(id: string) {
		this.sql.exec("delete from claude_relay_call where id=? and acked=0", id);
	}

	/**
	 * Sends the turn's unacked calls to its box: at once after a new call or
	 * a (re)connect, else only those not sent in the last few seconds.
	 */
	deliver(turnId: string, force = false) {
		const at = this.now();
		const rows = this.sql
			.exec(
				"select id,message from claude_relay_call where turn_id=? and acked=0 and sent_at<=? order by created_at",
				turnId,
				force ? at : at - RESEND_EVERY_MS,
			)
			.toArray() as { id: string; message: string }[];
		if (!rows.length) return;
		const boxes = this.sockets.box(turnId);
		if (!boxes.length) return;
		for (const row of rows) {
			for (const socket of boxes) {
				try {
					socket.send(row.message);
				} catch {}
			}
			this.sql.exec(
				"update claude_relay_call set sent_at=? where id=?",
				at,
				row.id,
			);
		}
	}

	ack(ids: readonly string[]) {
		for (const id of ids)
			this.sql.exec("update claude_relay_call set acked=1 where id=?", id);
	}

	/**
	 * The box's answer, to the call's socket; kept for the call's edge
	 * request to reconnect for when that socket is gone.
	 */
	reply(id: string, reply: McpCallResult, turnId = "") {
		const text = JSON.stringify({ t: "reply", reply });
		let sent = false;
		for (const socket of this.sockets.call(id)) {
			try {
				socket.send(text);
				sent = true;
			} catch {}
		}
		if (sent) this.sql.exec("delete from claude_relay_call where id=?", id);
		else
			this.sql.exec(
				"insert into claude_relay_call(id,turn_id,message,acked,created_at,reply) values(?,?,'{}',1,?,?) on conflict(id) do update set reply=excluded.reply,acked=1",
				id,
				turnId,
				this.now(),
				JSON.stringify(reply),
			);
	}

	tools(turnId: string, definitions: readonly unknown[]) {
		this.sql.exec(
			"insert into claude_relay_tools(turn_id,definitions,at) values(?,?,?) on conflict(turn_id) do update set definitions=excluded.definitions,at=excluded.at",
			turnId,
			JSON.stringify(definitions),
			this.now(),
		);
		this.sql.exec(
			"delete from claude_relay_tools where at<?",
			this.now() - 24 * 60 * 60_000,
		);
	}

	listedTools(turnId: string): readonly McpToolDefinition[] | null {
		const row = this.sql
			.exec(
				"select definitions from claude_relay_tools where turn_id=?",
				turnId,
			)
			.toArray()[0] as { definitions: string } | undefined;
		return row ? (JSON.parse(row.definitions) as McpToolDefinition[]) : null;
	}
}

/** The box's Claude messages on its turn socket, handled by the relay (not the lease writers). */
export function isClaudeRelayBoxMessage<T>(parsed: T): parsed is T & {
	t: "claude-tools" | "claude-ack" | "claude-reply";
} {
	const t = (parsed as { t?: unknown } | null)?.t;
	return t === "claude-tools" || t === "claude-ack" || t === "claude-reply";
}

export type ClaudeRelayCall = Pick<
	Extract<TurnBoxEdgeSocketMessage, { t: "claude-call" }>,
	"name" | "args" | "invocationId" | "timeoutMs" | "graceMs"
>;

type ChatStub = { fetch(request: Request): Promise<Response> };

/**
 * In the edge Worker: one relayed call, held here (a stateless request,
 * no duration billed) until the box answers through the chat's object.
 */
export async function relayClaudeCall(
	chat: ChatStub,
	grantHeader: string,
	call: ClaudeRelayCall,
	pause: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<McpCallResult> {
	const id = crypto.randomUUID();
	// A socket that closes before the answer (the object restarted, a
	// network blip) is opened again for the same call: the object runs it
	// once and keeps an answer that came meanwhile.
	for (let attempt = 0; ; attempt++) {
		const answer = await relayClaudeCallOnce(chat, grantHeader, call, id);
		if (answer !== "closed") return answer;
		if (attempt >= RELAY_RECONNECTS)
			return {
				text: "The turn's runner went away before this tool answered. Its outcome is unknown; inspect workspace state before retrying.",
				isError: true,
			};
		await pause(500 * (attempt + 1));
	}
}

/** How often a relayed call's socket is opened again before the call is given up. */
const RELAY_RECONNECTS = 4;

async function relayClaudeCallOnce(
	chat: ChatStub,
	grantHeader: string,
	call: ClaudeRelayCall,
	id: string,
): Promise<McpCallResult | "closed"> {
	const response = await chat.fetch(
		new Request(
			`https://chat.internal${CLAUDE_RELAY_CALL_PATH}?id=${encodeURIComponent(id)}`,
			{ headers: { upgrade: "websocket", authorization: grantHeader } },
		),
	);
	const socket = (response as Response & { webSocket?: WebSocket | null })
		.webSocket;
	if (response.status !== 101 || !socket)
		return {
			text: "ytimesy could not reach this turn's runner; try the tool again.",
			isError: true,
		};
	socket.accept();
	// Past the box's own timeout and grace (it answers those itself).
	const limitMs = call.timeoutMs + call.graceMs + 60_000;
	return new Promise<McpCallResult | "closed">((resolve) => {
		let done = false;
		const finish = (result: McpCallResult | "closed") => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				socket.close(1000, "done");
			} catch {}
			resolve(result);
		};
		const timer = setTimeout(
			() =>
				finish({
					text: "The tool's reply timed out. Its outcome is unknown; inspect workspace state and tracked jobs before retrying.",
					isError: true,
				}),
			limitMs,
		);
		socket.addEventListener("message", (event) => {
			try {
				const parsed = relayReplyMessage.safeParse(
					JSON.parse(String(event.data)),
				);
				if (parsed.success) finish(parsed.data.reply as McpCallResult);
			} catch {}
		});
		socket.addEventListener("close", () => finish("closed"));
		socket.send(
			JSON.stringify({ t: "call", ...call } satisfies RelayCallMessage),
		);
	});
}

/** In the edge Worker: the run's tools as the box published them (waits briefly for the first list). */
export async function relayedClaudeTools(
	listed: () => Promise<readonly McpToolDefinition[] | null>,
	sleep: (ms: number) => Promise<void> = (ms) =>
		new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<readonly McpToolDefinition[]> {
	for (let attempt = 0; attempt < 15; attempt++) {
		const tools = await listed().catch(() => null);
		if (tools) return tools;
		await sleep(1_000);
	}
	return [];
}

/** Whether a grant's MCP traffic is relayed to a box. */
export function relaysToBox(grant: ClaudeCodeGrant) {
	return grant.relay === "box";
}
