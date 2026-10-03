import { createHash } from "node:crypto";
import {
	agentSessionForOwner,
	sideAgentSession,
} from "../adapters/agent-sessions";
import { watchSessionProgress } from "../adapters/freestyle/session-progress";
import { progressAdapters } from "../adapters/session-progress";
import { serverSessionProgressResponse } from "./server-session-progress";
import { scopeSessionRuntimeText } from "./session-workspace-machines";

export async function sessionProgressResponse(input: {
	userId: string;
	projectId: string;
	sessionId: string;
	signal: AbortSignal;
	lane?: "main" | "side";
}) {
	const parent = await agentSessionForOwner(input.userId, input.sessionId);
	if (!parent || parent.projectId !== input.projectId)
		return new Response(null, { status: 404 });
	const session =
		input.lane === "side"
			? await sideAgentSession(input.userId, parent.id)
			: parent;
	if (!session || session.projectId !== input.projectId)
		return new Response(null, { status: 404 });
	if (session.harness === "api" || session.harness === "codex")
		return serverSessionProgressResponse({
			userId: input.userId,
			sessionId: session.id,
			displaySessionId: input.sessionId,
			signal: input.signal,
		});
	if (!session.providerRef || session.harness === "opencode")
		return new Response(null, { status: 409 });
	const apiKey = process.env.FREESTYLE_API_KEY;
	if (!apiKey) return new Response(null, { status: 503 });
	const adapter = progressAdapters[session.harness];
	const providerRef = session.providerRef;
	const paths = Object.fromEntries(
		Object.entries(adapter.paths).map(([key, path]) => [
			key,
			session.taskPlacement === "shared"
				? scopeSessionRuntimeText(path, session.id)
				: path,
		]),
	);
	const abort = new AbortController();
	const abortRequest = () => abort.abort();
	input.signal.addEventListener("abort", abortRequest, { once: true });
	if (input.signal.aborted) abort.abort();
	const encoder = new TextEncoder();
	let stop = () => {};
	let cancelled = false;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			let ended = false;
			let revision = "";
			const finish = () => {
				if (ended) return;
				ended = true;
				clearInterval(heartbeat);
				input.signal.removeEventListener("abort", abortRequest);
				abort.abort();
				stop();
				if (!cancelled) controller.close();
			};
			const heartbeat = setInterval(
				() => controller.enqueue(encoder.encode(": heartbeat\n\n")),
				10_000,
			);
			abort.signal.addEventListener("abort", finish, { once: true });
			controller.enqueue(encoder.encode("retry: 1000\n\n"));
			void watchSessionProgress({
				apiKey,
				providerRef,
				paths,
				signal: abort.signal,
				onFiles(files) {
					if (ended) return;
					const progress = adapter.parse(files, session.id);
					if (!progress) return;
					const data = JSON.stringify({
						...progress,
						sessionId: input.sessionId,
					});
					const id = createHash("sha256").update(data).digest("hex");
					if (id === revision) return;
					revision = id;
					if ((controller.desiredSize ?? 0) < -32) {
						finish();
						return;
					}
					controller.enqueue(
						encoder.encode(`id: ${id}\nevent: progress\ndata: ${data}\n\n`),
					);
				},
				onClose: finish,
			})
				.then((close) => {
					stop = close;
					if (ended) close();
				})
				.catch(finish);
		},
		cancel() {
			cancelled = true;
			abort.abort();
			stop();
		},
	});
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
