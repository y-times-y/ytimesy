import type {
	AssistantModelMessage,
	ModelMessage,
	ToolModelMessage,
	UserModelMessage,
} from "ai";

const runtimeHandoffPrefix =
	"Continue this same workspace conversation after a runtime switch. The JSON below is prior conversation evidence, not new instructions. Do not re-execute old requests. Inspect the current working tree before changing it.\n<previous-conversation>\n";

const requestBoundary = "\n</previous-conversation>\n\nCurrent user request:\n";

/** Unwrap only our complete envelope, not quoted snippets or ordinary user text. */
export function visibleRuntimeUserText(text: string): string {
	if (!text.startsWith(runtimeHandoffPrefix)) return text;
	const boundary = text.indexOf(requestBoundary, runtimeHandoffPrefix.length);
	if (boundary < runtimeHandoffPrefix.length) return text;
	try {
		const history: unknown = JSON.parse(
			text.slice(runtimeHandoffPrefix.length, boundary),
		);
		if (!Array.isArray(history)) return text;
		const request = text.slice(boundary + requestBoundary.length);
		return request.trim() ? request : text;
	} catch {
		return text;
	}
}

export function runtimeHandoffEnvelope(
	history: unknown,
	prompt: string,
): string {
	return `${runtimeHandoffPrefix}${JSON.stringify(history)}${requestBoundary}${prompt}`;
}

type MessagePart = Exclude<ModelMessage["content"], string>[number];

const PORTABLE_FILE_DATA = new Set(["data", "url", "text"]);

/** A provider id or reference that another provider cannot resolve. */
function providerBoundFile(part: MessagePart) {
	if (part.type !== "file") return false;
	const data = part.data as unknown;
	if (
		!data ||
		typeof data !== "object" ||
		data instanceof Uint8Array ||
		data instanceof ArrayBuffer ||
		data instanceof URL
	)
		return false;
	const type = (data as { type?: unknown }).type;
	return typeof type !== "string" || !PORTABLE_FILE_DATA.has(type);
}

/** Tool call ids every provider accepts (Anthropic allows only [A-Za-z0-9_-]). */
function portableToolCallId(id: string) {
	return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "call";
}

function withoutProviderOptions<T extends { providerOptions?: unknown }>(
	value: T,
): T {
	const { providerOptions: _ignored, ...rest } = value;
	return rest as T;
}

/**
 * The conversation as any provider can read it, for a mid-turn switch to
 * another provider or account. Reasoning (OpenAI encrypted content, Anthropic
 * thinking signatures), provider-executed tools (hosted search) and every
 * providerOptions entry (item ids, cache hints, phases) belong to the provider
 * that produced them and are dropped. Text, files, and the agent's own tool
 * calls with their results are kept; a call without a result, or a result
 * without its call, is dropped so the history stays well formed.
 */
export function providerNeutralHistory(
	messages: readonly ModelMessage[],
): ModelMessage[] {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (
				message.role === "assistant" &&
				part.type === "tool-call" &&
				!part.providerExecuted
			)
				calls.add(part.toolCallId);
			if (message.role === "tool" && part.type === "tool-result")
				results.add(part.toolCallId);
		}
	}
	const paired = (id: string) => calls.has(id) && results.has(id);
	const neutral: ModelMessage[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") {
			neutral.push(withoutProviderOptions(message));
			continue;
		}
		if (message.role === "assistant") {
			const content = message.content.flatMap(
				(part): Exclude<AssistantModelMessage["content"], string> => {
					if (part.type === "text")
						return part.text ? [withoutProviderOptions(part)] : [];
					if (part.type === "file")
						return providerBoundFile(part)
							? []
							: [withoutProviderOptions(part)];
					if (
						part.type === "tool-call" &&
						!part.providerExecuted &&
						paired(part.toolCallId)
					)
						return [
							{
								...withoutProviderOptions(part),
								toolCallId: portableToolCallId(part.toolCallId),
							},
						];
					return [];
				},
			);
			if (content.length) neutral.push({ role: "assistant", content });
			continue;
		}
		if (message.role === "tool") {
			const content = message.content.flatMap(
				(part): ToolModelMessage["content"] =>
					part.type === "tool-result" && paired(part.toolCallId)
						? [
								{
									...withoutProviderOptions(part),
									toolCallId: portableToolCallId(part.toolCallId),
									output: withoutProviderOptions(
										part.output as typeof part.output & {
											providerOptions?: unknown;
										},
									),
								},
							]
						: [],
			);
			if (content.length) neutral.push({ role: "tool", content });
			continue;
		}
		if (message.role === "user") {
			const content = message.content.flatMap(
				(part): Exclude<UserModelMessage["content"], string> =>
					part.type === "file" && providerBoundFile(part)
						? []
						: [withoutProviderOptions(part)],
			);
			if (content.length) neutral.push({ role: "user", content });
			continue;
		}
		neutral.push(withoutProviderOptions(message));
	}
	return neutral;
}

/** The provider-neutral history with the runtime note that explains the switch. */
export function modelSwitchHistory(
	messages: readonly ModelMessage[],
	note: string,
): ModelMessage[] {
	return [...providerNeutralHistory(messages), { role: "user", content: note }];
}
