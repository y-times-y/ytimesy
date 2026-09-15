export function assistantTextFromOpenCode(payload: unknown): string | null {
	const texts = textPartsFromOpenCode(payload);
	if (texts.length > 0) return texts.join("\n").trim() || null;
	if (typeof payload === "string" && payload.trim()) return payload.trim();
	return null;
}

export function assistantTextFromOpenCodeMessages(
	payload: unknown,
): string | null {
	const messages = openCodeMessageRows(payload);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const row = messages[index];
		if (!row || openCodeMessageRole(row) === "user") continue;
		const text = assistantTextFromOpenCode(row);
		if (text) return text;
	}
	return null;
}

export function errorMessageFromOpenCode(payload: unknown): string | null {
	if (payload == null) return null;
	if (typeof payload === "string") {
		const trimmed = payload.trim();
		return looksLikeOpenCodeError(trimmed) ? trimmed : null;
	}
	if (Array.isArray(payload)) {
		for (const row of payload) {
			const nested = errorMessageFromOpenCode(row);
			if (nested) return nested;
		}
		return null;
	}
	if (!isRecord(payload)) return null;
	const direct =
		readNonEmpty(payload.error) ||
		readNonEmpty(payload.message) ||
		(isRecord(payload.error) ? readNonEmpty(payload.error.message) : undefined);
	if (direct) return direct;
	if (isRecord(payload.error)) {
		const wrappedError = errorMessageFromOpenCode(payload.error);
		if (wrappedError) return wrappedError;
	}
	if (isRecord(payload.info)) {
		const infoError = errorMessageFromOpenCode(payload.info);
		if (infoError) return infoError;
	}
	if (isRecord(payload.data)) {
		const dataError = errorMessageFromOpenCode(payload.data);
		if (dataError) return dataError;
	}
	for (const row of openCodeMessageRows(payload)) {
		if (row === payload) continue;
		const nested = errorMessageFromOpenCode(row);
		if (nested) return nested;
	}
	return null;
}

export function openCodeSessionIsBusy(
	status: unknown,
	sessionId: string,
): boolean {
	if (!isRecord(status)) return false;
	const row = status[sessionId];
	if (typeof row === "string")
		return row === "busy" || row === "running" || row === "retry";
	if (!isRecord(row)) return false;
	const type = readNonEmpty(row.type) ?? readNonEmpty(row.status);
	return type === "busy" || type === "running" || type === "retry";
}

export const OPENCODE_TURN_MAX_WAIT_MS = 180_000;

export function openCodeTurnFailureMessage(input: {
	readonly payload: unknown;
	readonly httpStatus?: number;
}): string {
	const fromPayload = errorMessageFromOpenCode(input.payload);
	if (fromPayload) return fromPayload;
	if (input.httpStatus && input.httpStatus >= 400) {
		return `OpenCode HTTP ${input.httpStatus}. ytimesy did not fall back to another provider.`;
	}
	return "OpenCode listed no assistant text. ytimesy did not fall back to another provider.";
}

/**
 * Busy can clear before `/message` has the assistant text. Keep polling
 * until the turn budget expires unless OpenCode reported an error.
 */
export function openCodeTurnPollDecision(input: {
	readonly busy: boolean;
	readonly seenBusy: boolean;
	readonly hasAssistantText: boolean;
	readonly hasError: boolean;
	readonly elapsedMs: number;
	readonly msSinceLastBusy: number | null;
}): "running" | "completed" | "failed" {
	if (input.busy) return "running";
	if (input.hasAssistantText) return "completed";
	if (input.hasError) return "failed";
	if (input.elapsedMs > OPENCODE_TURN_MAX_WAIT_MS) return "failed";
	return "running";
}

function textPartsFromOpenCode(payload: unknown): string[] {
	if (!isRecord(payload)) return [];
	if (typeof payload.text === "string" && payload.text.trim()) {
		return [payload.text.trim()];
	}
	const parts = Array.isArray(payload.parts)
		? payload.parts
		: isRecord(payload.info) && Array.isArray(payload.info.parts)
			? payload.info.parts
			: [];
	const texts: string[] = [];
	for (const part of parts) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && readNonEmpty(part.text)) {
			texts.push(String(part.text).trim());
		}
	}
	return texts;
}

function openCodeMessageRows(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	if (!isRecord(payload)) return [];
	if (Array.isArray(payload.messages)) return payload.messages;
	if (Array.isArray(payload.data)) return payload.data;
	if (isRecord(payload.info) && Array.isArray(payload.parts)) return [payload];
	return [];
}

function openCodeMessageRole(row: unknown): string | undefined {
	if (!isRecord(row)) return undefined;
	if (isRecord(row.info)) return readNonEmpty(row.info.role);
	return readNonEmpty(row.role);
}

function looksLikeOpenCodeError(text: string): boolean {
	return /error|failed|unauthorized|quota|limit|not found/i.test(text);
}

function readNonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
