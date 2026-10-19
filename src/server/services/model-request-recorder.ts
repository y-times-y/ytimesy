import { createHash } from "node:crypto";
import {
	type ModelRequestBody,
	type ModelRequestTool,
	saveModelRequest,
} from "../adapters/model-request-log";

/** What the model loop hands over just before a provider call. */
export type ModelRequestSnapshot = {
	readonly instructions: string;
	/** The prepared tool definitions actually sent (after activeTools filtering). */
	readonly tools: ReadonlyArray<Record<string, unknown>> | undefined;
};

function requestTool(tool: Record<string, unknown>): ModelRequestTool {
	const text = (value: unknown) =>
		typeof value === "string" ? value : undefined;
	return {
		name: text(tool.name) ?? "",
		type: text(tool.type) ?? "function",
		...(text(tool.description) !== undefined
			? { description: text(tool.description) }
			: {}),
		...(tool.inputSchema !== undefined
			? { inputSchema: tool.inputSchema }
			: {}),
		...(text(tool.id) !== undefined ? { id: text(tool.id) } : {}),
	};
}

/** The stored form of a request: its body (deduplicated by hash) and tool names. */
export function modelRequestBody(snapshot: ModelRequestSnapshot): {
	hash: string;
	body: ModelRequestBody;
} {
	const body: ModelRequestBody = {
		version: 1,
		instructions: snapshot.instructions,
		tools: (snapshot.tools ?? []).map(requestTool),
	};
	return {
		hash: createHash("sha256")
			.update(JSON.stringify(body))
			.digest("hex")
			.slice(0, 32),
		body,
	};
}

/**
 * Development evals only: records every model request of one step in the
 * session's journal (model-request-log.ts). A failed write is logged and
 * never fails the turn; flush() waits for the writes before the step ends.
 */
export function modelRequestRecorder(input: {
	sessionId: string;
	turnId: string;
	step: number;
	save?: typeof saveModelRequest;
}) {
	const save = input.save ?? saveModelRequest;
	const pending: Promise<void>[] = [];
	let call = 0;
	return {
		record(snapshot: ModelRequestSnapshot) {
			const { hash, body } = modelRequestBody(snapshot);
			pending.push(
				save(
					input.sessionId,
					{
						version: 1,
						turnId: input.turnId,
						step: input.step,
						call: call++,
						at: new Date().toISOString(),
						hash,
						tools: body.tools.map((tool) => tool.name),
					},
					body,
				).catch((error) => {
					console.warn("Model request was not recorded.", error);
				}),
			);
		},
		async flush() {
			await Promise.all(pending.splice(0));
		},
	};
}
