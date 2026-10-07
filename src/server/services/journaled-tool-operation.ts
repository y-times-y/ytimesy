import { publicToolDetail } from "#/domain/tool-detail";
import {
	claimAgentTaskCommand,
	completeAgentTaskCommand,
	renewAgentTaskCommandClaim,
} from "../adapters/agent-task-command-receipts";

export async function journaledToolOperation(
	input: {
		sessionId: string;
		requestId: string;
		fingerprint: string;
		signal: AbortSignal;
	},
	run: () => Promise<unknown>,
) {
	const { signal, requestId, fingerprint: requestFingerprint } = input;
	signal.throwIfAborted();
	const receipt = await claimAgentTaskCommand(input.sessionId, requestId);
	if (receipt.kind === "done") {
		if (receipt.response.requestFingerprint !== requestFingerprint)
			throw new Error(
				"Recorded tool inputs differ or predate input validation; inspect the existing outcome before making a new request. No operation was replayed.",
			);
		if (!receipt.response.ok)
			throw new Error(
				receipt.response.error || "The recorded tool call failed.",
			);
		return receipt.response.result;
	}
	if (receipt.kind === "processing")
		throw new Error(
			"Tool outcome is uncertain; inspect the workspace before retrying.",
		);
	const heartbeat = setInterval(
		() =>
			void renewAgentTaskCommandClaim(input.sessionId, requestId).catch(
				() => {},
			),
		10_000,
	);
	let executed = false;
	try {
		const result = await run();
		executed = true;
		signal.throwIfAborted();
		await completeAgentTaskCommand(input.sessionId, {
			id: requestId,
			requestFingerprint,
			ok: true,
			result,
		});
		return result;
	} catch (error) {
		if (!executed && !signal.aborted) {
			const message = publicToolDetail(
				error instanceof Error ? error.message : "Tool execution failed.",
			);
			const recorded = `Tool call failed: ${message} If this was a write, inspect its state before retrying; partial effects may exist.`;
			await completeAgentTaskCommand(input.sessionId, {
				id: requestId,
				requestFingerprint,
				ok: false,
				error: recorded,
			}).catch(() => {});
			throw new Error(recorded);
		}
		throw error;
	} finally {
		clearInterval(heartbeat);
	}
}
