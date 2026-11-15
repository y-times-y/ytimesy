import { DurableObject } from "cloudflare:workers";
import { LIVE_SOCKET_CLOSE } from "../../domain/live-progress-socket";
import type { SessionTurnStatus } from "../../domain/session-item";
import {
	applyHubTurnChange,
	type HubChats,
	type HubStatusEntries,
	type HubTurnChange,
	hubStateMessage,
	hubStatusEntries,
	MAX_HUB_SOCKETS,
	staleHubChats,
	USER_HUB_AUTHORIZATION_MS,
	USER_HUB_EDGE_PATH,
} from "../../domain/user-hub";
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
 * One user's chats' turn status, pushed to that user's open tabs over
 * hibernatable sockets: the whole map on connect, then only what changed.
 * Fed by each chat's ModelConversation when a turn starts and settles. The
 * map is in SQLite, so it survives eviction and deploys; between pushes the
 * object sleeps and pings are answered by the runtime.
 */
export class UserHub extends DurableObject<EdgeExecutorEnvironment> {
	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		ctx.storage.sql.exec(`create table if not exists hub_chat(
			session_id text primary key, turn_status text not null, updated_at integer not null)`);
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
		server.send(hubStateMessage(hubStatusEntries(this.chats()), true));
		return upgradeResponse(client);
	}

	private sockets(): ServerSocket[] {
		return this.ctx.getWebSockets(HUB_SOCKET_TAG) as unknown as ServerSocket[];
	}

	/**
	 * Sends the changed entries to every socket; one whose sign-in check
	 * expired is closed instead, and its reconnect gets the whole map.
	 */
	private push(entries: HubStatusEntries) {
		const message = hubStateMessage(entries);
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
