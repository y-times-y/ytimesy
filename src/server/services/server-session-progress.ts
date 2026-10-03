import { conversationEvent } from "#/domain/conversation-delivery";
import { conversationSnapshot } from "../adapters/conversation-delivery";
import { subscribeConversationSnapshot } from "../adapters/realtime-delivery";

/** Development fallback only; live deployments fan out through the configured DO relay. */
export async function serverSessionProgressResponse(input: {
	userId: string;
	sessionId: string;
	displaySessionId: string;
	signal: AbortSignal;
}) {
	const initial = await conversationSnapshot(input.userId, input.sessionId);
	if (!initial) return new Response(null, { status: 404 });
	const realtime = await subscribeConversationSnapshot(
		initial,
		input.displaySessionId,
		input.signal,
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
				let revision = initial.revision;
				controller.enqueue(
					encoder.encode(conversationEvent(initial, input.displaySessionId)),
				);
				const poll = setInterval(() => {
					if (ended || busy) return;
					busy = true;
					void conversationSnapshot(input.userId, input.sessionId)
						.then((next) => {
							if (ended) return;
							if (!next || (controller.desiredSize ?? 0) <= 0) {
								stop();
								return;
							}
							if (BigInt(next.revision) > BigInt(revision)) {
								revision = next.revision;
								controller.enqueue(
									encoder.encode(
										conversationEvent(next, input.displaySessionId),
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
