import {
	CLAUDE_FEED_LIVE_MS,
	CLAUDE_FEED_PROTOCOL,
	CLAUDE_FEED_QUIET_MS,
} from "./claude-feed";

/**
 * The feed's sending end, part of the runner program on the VM
 * (claude-agent-runner.ts), as JavaScript source: it runs under the VM's
 * Node, not in this build. The runner still writes every line to stdout (the
 * out file the step can always poll); this only pushes the same lines, with
 * their byte offsets in that file, to the chat's object (claude-feed.ts).
 *
 * Batches go out every second while someone watches the chat (mode "live"),
 * every 10 s otherwise ("quiet"), and at once for the run's start, a tool
 * call, its result and its exit; an idle socket beats every 20 s. Lines stay
 * buffered until acknowledged, so a reconnect (with backoff) resends from
 * what the object holds. Anything it cannot recover from (the object lost
 * lines no longer buffered, the buffer outgrew its cap, "stop") ends the
 * feed for good: the step then polls the out file as before.
 *
 * The functions before createFeed are pure, exercised by the tests.
 */
export const CLAUDE_FEED_SENDER_SOURCE = `const FEED_PROTOCOL = ${JSON.stringify(CLAUDE_FEED_PROTOCOL)};
const FEED_LIVE_MS = ${CLAUDE_FEED_LIVE_MS};
const FEED_QUIET_MS = ${CLAUDE_FEED_QUIET_MS};
const FEED_BEAT_MS = 20000;
const FEED_MAX_LINE = 512 * 1024;
const FEED_MAX_BATCH = 900000;
const FEED_MAX_BUFFER = 16 * 1024 * 1024;
const FEED_OVERSIZE = JSON.stringify({ type: "ytimesy_oversize" });
function feedUrgent(message) {
	if (!message || typeof message !== "object") return false;
	if (message.type === "result") return true;
	if (message.type === "system") return message.subtype === "init";
	return message.type === "assistant" && Array.isArray(message.message?.content) &&
		message.message.content.some((block) => block?.type === "tool_use");
}
function feedFlushDelay(mode, pendingSince, urgent, now) {
	if (pendingSince === null) return null;
	if (urgent) return 0;
	return Math.max(0, pendingSince + (mode === "live" ? FEED_LIVE_MS : FEED_QUIET_MS) - now);
}
function feedBeatDue(lastSentAt, now) {
	return now - lastSentAt >= FEED_BEAT_MS;
}
function feedBackoff(attempt) {
	return Math.min(60000, 1000 * 2 ** Math.min(attempt, 6));
}
function feedEntry(offset, line) {
	const next = offset + Buffer.byteLength(line) + 1;
	const fits = next - offset <= FEED_MAX_LINE && JSON.stringify(line).length <= FEED_MAX_BATCH;
	return { offset, next, line: fits ? line : FEED_OVERSIZE };
}
function feedStalled(stalls) {
	return stalls >= 5;
}
function feedBatch(buffer, from, maxChars) {
	let start = buffer.findIndex((entry) => entry.offset >= from);
	if (start < 0) return null;
	const entries = [];
	let size = 0;
	let to = from;
	for (let index = start; index < buffer.length; index++) {
		const entry = buffer[index];
		const cost = JSON.stringify(entry.line).length + 24;
		if (entries.length && size + cost > maxChars) break;
		entries.push([entry.offset, entry.line]);
		size += cost;
		to = entry.next;
	}
	return { type: "lines", from: entries[0][0], to, entries };
}
function createFeed(config) {
	const buffer = [];
	let base = 0, written = 0, buffered = 0, acked = 0, sentTo = 0;
	let socket = null, ready = false, closed = false, attempt = 0, stalls = 0;
	let mode = "quiet", pendingSince = null, urgent = false, lastSentAt = Date.now();
	let exitStatus = null, exitSent = false, finished = null;
	const send = (message) => {
		try {
			socket.send(JSON.stringify(message));
			lastSentAt = Date.now();
			return true;
		} catch {
			return false;
		}
	};
	const end = () => {
		closed = true;
		clearInterval(tick);
		buffer.length = 0;
		try { socket?.close(1000); } catch {}
		finished?.();
	};
	const flush = () => {
		if (!ready || closed) return;
		for (;;) {
			const batch = feedBatch(buffer, sentTo, FEED_MAX_BATCH);
			if (!batch || !send(batch)) break;
			sentTo = batch.to;
		}
		pendingSince = null;
		urgent = false;
		if (exitStatus !== null && sentTo >= written && send({ type: "exit", status: exitStatus })) exitSent = true;
	};
	const retry = () => {
		if (closed) return;
		const timer = setTimeout(connect, feedBackoff(attempt++));
		timer.unref?.();
	};
	const handle = (message) => {
		if (message?.type === "stop") return end();
		if (message?.type === "need") {
			if (!(message.from >= base && message.from <= written)) return end();
			sentTo = message.from;
			return flush();
		}
		if (message?.type !== "ack" || typeof message.receivedTo !== "number") return;
		if (message.receivedTo < base || message.receivedTo > written) return end();
		mode = message.mode === "live" ? "live" : "quiet";
		if (message.receivedTo > acked) stalls = 0;
		acked = Math.max(acked, message.receivedTo);
		while (buffer.length && buffer[0].next <= acked) {
			const entry = buffer.shift();
			buffered -= entry.line.length;
			base = entry.next;
		}
		if (!ready) {
			ready = true;
			sentTo = message.receivedTo;
			flush();
		}
		if (exitSent && acked >= written) end();
	};
	const connect = () => {
		if (closed) return;
		let ws;
		try {
			ws = new WebSocket(config.url, [FEED_PROTOCOL, config.grant]);
		} catch {
			return retry();
		}
		socket = ws;
		ready = false;
		ws.onopen = () => {
			attempt = 0;
			send({ type: "hello", turnId: config.turnId, run: config.run, receivedFrom: base });
		};
		ws.onmessage = (event) => {
			try {
				handle(JSON.parse(String(event.data)));
			} catch {}
		};
		ws.onclose = () => {
			if (socket !== ws) return;
			socket = null;
			ready = false;
			if (exitStatus !== null) return end();
			// Lines the object keeps not taking (a message it refuses, say):
			// reconnecting would only keep the feed looking alive.
			if (sentTo > acked && feedStalled(++stalls)) return end();
			retry();
		};
		ws.onerror = () => {};
	};
	const tick = setInterval(() => {
		if (closed) return;
		const now = Date.now();
		if (feedFlushDelay(mode, pendingSince, urgent, now) === 0) flush();
		else if (ready && feedBeatDue(lastSentAt, now)) send({ type: "beat" });
	}, 250);
	tick.unref?.();
	connect();
	return {
		push(line, message) {
			if (closed) return;
			const entry = feedEntry(written, line);
			written = entry.next;
			buffer.push(entry);
			buffered += entry.line.length;
			if (buffered > FEED_MAX_BUFFER) return end();
			if (pendingSince === null) pendingSince = Date.now();
			if (feedUrgent(message)) urgent = true;
			if (urgent) flush();
		},
		finish(status) {
			// No socket now: the step reads the rest, and the exit, from the out file.
			if (closed || !socket) {
				end();
				return Promise.resolve();
			}
			exitStatus = status;
			flush();
			if (closed) return Promise.resolve();
			// A held timer: with only unref'd handles left, Node would end the
			// program on this await with code 13, read as the run's exit status.
			return new Promise((resolve) => {
				const timer = setTimeout(end, 5000);
				finished = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		},
	};
}
`;
