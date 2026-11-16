import { DurableObject } from "cloudflare:workers";
import { LIVE_SOCKET_CLOSE } from "../../domain/live-progress-socket";
import type { SessionTurnStatus } from "../../domain/session-item";
import {
	applyHubSignals,
	applyHubTurnChange,
	type HubChats,
	type HubSignals,
	type HubStatusEntries,
	type HubTurnChange,
	hubStateMessage,
	hubStatusEntries,
	MAX_HUB_SOCKETS,
	staleHubChats,
	staleHubSignals,
	USER_HUB_AUTHORIZATION_MS,
	USER_HUB_EDGE_PATH,
} from "../../domain/user-hub";
import { BUILD_ID } from "../../lib/build-id";
import {
	pingAutoResponse,
	type ServerSocket,
	socketPair,
	upgradeResponse,
} from "../../realtime/socket-upgrade";
import type { EdgeExecutorEnvironment } from "./environment";

const HUB_SOCKET_TAG = "hub";
type HubSocketAttachment = { openedAt: number; authorizedUntil: number };

function hubSocketAttachment(socket: ServerSocket): HubSocketAttachment | null {
	try {
		const value = socket.deserializeAttachment() as HubSocketAttachment | null;
		return value && typeof value.authorizedUntil === "number" ? value : null;
	} catch {
		return null;
	}
}

/**
 * One user's chats' turn status and change signals (hubTopic), pushed to
 * that user's open tabs over hibernatable sockets: the whole map on connect
 * (with this deploy's build id), then only what changed. Turn status is fed
 * by each chat's ModelConversation when a turn starts and settles; signals
 * by whatever changed (noteUserHub). Both are in SQLite, so they survive
 * eviction and deploys; between pushes the object sleeps and pings are
 * answered by the runtime.
 */
export class UserHub extends DurableObject<EdgeExecutorEnvironment> {
	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		ctx.storage.sql.exec(`create table if not exists hub_chat(
			session_id text primary key, turn_status text not null, updated_at integer not null)`);
		ctx.storage.sql.exec(`create table if not exists hub_signal(
			topic text primary key, at integer not null)`);
		ctx.setWebSocketAutoResponse(
			pingAutoResponse() as WebSocketRequestResponsePair,
		);
	}

	private chats(): HubChats {
		const rows = this.ctx.storage.sql
			.exec<{ id: string; status: string; at: number }>(
				"select session_id as id,turn_status as status,updated_at as at from hub_chat",
			)
			.toArray();
		return Object.fromEntries(
			rows.map((row) => [
				row.id,
				{ turnStatus: row.status as SessionTurnStatus, updatedAt: row.at },
			]),
		);
	}

	private signals(): HubSignals {
		return Object.fromEntries(
			this.ctx.storage.sql
				.exec<{ topic: string; at: number }>("select topic,at from hub_signal")
				.toArray()
				.map((row: { topic: string; at: number }) => [row.topic, row.at]),
		);
	}

	/** Something a tab shows changed (RPC from the edge, or the web Worker's note). */
	async noteSignals(topics: readonly string[]) {
		const { signals, pushed } = applyHubSignals(
			this.signals(),
			topics,
			Date.now(),
		);
		if (!Object.keys(pushed).length) return;
		for (const [topic, at] of Object.entries(pushed))
			this.ctx.storage.sql.exec(
				"insert into hub_signal(topic,at) values(?,?) on conflict(topic) do update set at=excluded.at",
				topic,
				at,
			);
		for (const topic of staleHubSignals(signals))
			this.ctx.storage.sql.exec("delete from hub_signal where topic=?", topic);
		this.push({}, pushed);
	}

	/** A chat's turn started or settled (RPC from its ModelConversation). */
	async noteTurn(change: HubTurnChange) {
		const previous = this.chats();
		const { chats, pushed } = applyHubTurnChange(previous, change);
		if (chats === previous) return;
		this.ctx.storage.sql.exec(
			`insert into hub_chat(session_id,turn_status,updated_at) values(?,?,?)
			 on conflict(session_id) do update set turn_status=excluded.turn_status,updated_at=excluded.updated_at`,
			change.sessionId,
			change.turnStatus,
			change.at,
		);
		for (const id of staleHubChats(chats))
			this.ctx.storage.sql.exec("delete from hub_chat where session_id=?", id);
		if (pushed) this.push(pushed);
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname !== USER_HUB_EDGE_PATH)
			return new Response(null, { status: 404 });
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
			return new Response(null, { status: 426 });
		if (this.sockets().length >= MAX_HUB_SOCKETS)
			return new Response(null, { status: 429 });
		const { client, server } = socketPair();
		this.ctx.acceptWebSocket(server as unknown as WebSocket, [HUB_SOCKET_TAG]);
		const openedAt = Date.now();
		server.serializeAttachment({
			openedAt,
			authorizedUntil: openedAt + USER_HUB_AUTHORIZATION_MS,
		} satisfies HubSocketAttachment);
		server.send(
			hubStateMessage(hubStatusEntries(this.chats()), true, {
				signals: this.signals(),
				build: BUILD_ID,
			}),
		);
		return upgradeResponse(client);
	}

	private sockets(): ServerSocket[] {
		return this.ctx.getWebSockets(HUB_SOCKET_TAG) as unknown as ServerSocket[];
	}

	/**
	 * Sends the changed entries to every socket; one whose sign-in check
	 * expired is closed instead, and its reconnect gets the whole map.
	 */
	private push(entries: HubStatusEntries, signals?: HubSignals) {
		const message = hubStateMessage(entries, false, { signals });
		const now = Date.now();
		for (const socket of this.sockets()) {
			const attachment = hubSocketAttachment(socket);
			try {
				if (attachment && attachment.authorizedUntil > now)
					socket.send(message);
				else socket.close(LIVE_SOCKET_CLOSE.reauthorize, "reauthorize");
			} catch {
				// A socket closing meanwhile: its close handler ends it.
			}
		}
	}

	/** Only a ping is expected, and the runtime answers it. */
	webSocketMessage() {}
	webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	) {
		try {
			socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {}
	}
	webSocketError() {}
}
