import {
	applyConversationDelta,
	type ConversationDelta,
	type ConversationSnapshot,
	conversationDeltaEvent,
	conversationEvent,
	isConversationDelta,
} from "#/domain/conversation-delivery";
import {
	conversationSnapshot,
	conversationUpdateSince,
} from "../adapters/conversation-delivery";
import { subscribeConversationSnapshot } from "../adapters/realtime-delivery";

/** Development fallback only; live deployments fan out through the configured DO relay. */
export async function serverSessionProgressResponse(input: {
	userId: string;
	sessionId: string;
	signal: AbortSignal;
	/** The viewer merges `delta` events; otherwise it is sent full snapshots only. */
	deltas?: boolean;
}) {
	const initial = await conversationSnapshot(input.userId, input.sessionId);
	if (!initial) return new Response(null, { status: 404 });
	const realtime = await subscribeConversationSnapshot(
		initial,
		input.signal,
		input.deltas,
	);
	if (realtime) return realtime;
	const encoder = new TextEncoder();
	let stop = () => {};
	let cancelled = false;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let ended = false;
				let busy = false;
				// The stream's copy: each poll reads only the rows written since it.
				let copy: ConversationSnapshot = initial;
				controller.enqueue(encoder.encode(conversationEvent(initial)));
				const read = async (): Promise<{
					next: ConversationSnapshot;
					delta?: ConversationDelta;
				} | null> => {
					const since = copy.window?.itemsRev;
					const update = since
						? await conversationUpdateSince(
								input.userId,
								input.sessionId,
								since,
							)
						: await conversationSnapshot(input.userId, input.sessionId);
					if (!update) return null;
					if (!isConversationDelta(update)) return { next: update };
					if (BigInt(update.revision) <= BigInt(copy.revision))
						return { next: copy };
					const merged = applyConversationDelta(copy, update);
					if (merged)
						return {
							next: { ...copy, revision: update.revision, ...merged },
							delta: update,
						};
					// The copy lost track: start again from a full snapshot.
					const full = await conversationSnapshot(
						input.userId,
						input.sessionId,
					);
					return full && { next: full };
				};
				const poll = setInterval(() => {
					if (ended || busy) return;
					busy = true;
					void read()
						.then((result) => {
							if (ended) return;
							if (!result || (controller.desiredSize ?? 0) <= 0) {
								stop();
								return;
							}
							const { next, delta } = result;
							if (BigInt(next.revision) > BigInt(copy.revision)) {
								copy = next;
								controller.enqueue(
									encoder.encode(
										delta && input.deltas
											? conversationDeltaEvent(delta)
											: conversationEvent(next),
									),
								);
							}
						})
						.catch(stop)
						.finally(() => {
							busy = false;
						});
				}, 500);
				const heartbeat = setInterval(() => {
					if (!ended && (controller.desiredSize ?? 0) > 0)
						controller.enqueue(encoder.encode(": heartbeat\n\n"));
				}, 10_000);
				stop = () => {
					if (ended) return;
					ended = true;
					clearInterval(poll);
					clearInterval(heartbeat);
					input.signal.removeEventListener("abort", stop);
					if (!cancelled) controller.close();
				};
				input.signal.addEventListener("abort", stop, { once: true });
				if (input.signal.aborted) stop();
			},
			cancel() {
				cancelled = true;
				stop();
			},
		},
		{ highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
	);
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
