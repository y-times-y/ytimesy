import { asSchema, type Tool, type ToolSet } from "ai";
import type {
	McpCallResult,
	McpContentBlock,
	McpToolDefinition,
} from "#/domain/claude-code-mcp";

/**
 * How one of ytimesy's tools answers an MCP call from Claude Code, wherever
 * it runs: in the chat's Durable Object (claude-code-bridge.ts) or on the
 * Claude runner box (claude-box-tools/). Pure over the tool: no bridge state,
 * no timeline.
 */
type ExecuteOptions = Parameters<NonNullable<Tool["execute"]>>[1];

export async function mcpToolDefinitions(
	tools: ToolSet,
): Promise<McpToolDefinition[]> {
	return Promise.all(
		Object.entries(tools)
			.filter(([, definition]) => typeof definition.execute === "function")
			.map(async ([name, definition]) => ({
				name,
				description:
					typeof definition.description === "string"
						? definition.description
						: name,
				inputSchema: (await asSchema(definition.inputSchema)
					.jsonSchema) as Record<string, unknown>,
			})),
	);
}

/**
 * What the tool's own model conversion says the model should see: text and
 * image blocks, so a screenshot reaches Claude as pixels instead of its
 * base64 written out as text. Other shapes use the plain text reply.
 */
export async function modelContentBlocks(
	definition: Tool,
	options: { toolCallId: string; input: unknown; output: unknown },
): Promise<McpContentBlock[] | undefined> {
	if (!definition.toModelOutput) return undefined;
	const converted = (await definition.toModelOutput(options as never)) as {
		type?: string;
		value?: unknown;
	};
	if (converted?.type !== "content" || !Array.isArray(converted.value))
		return undefined;
	const blocks: McpContentBlock[] = [];
	for (const part of converted.value as Record<string, unknown>[]) {
		if (part.type === "text" && typeof part.text === "string")
			blocks.push({ type: "text", text: part.text });
		else if (
			(part.type === "file" || part.type === "image") &&
			typeof part.mediaType === "string" &&
			part.mediaType.startsWith("image/")
		) {
			const data = part.data as { type?: string; data?: unknown } | undefined;
			if (data?.type === "data" && typeof data.data === "string")
				blocks.push({
					type: "image",
					data: data.data,
					mimeType: part.mediaType,
				});
		}
	}
	return blocks.some((block) => block.type === "image") ? blocks : undefined;
}

function outputText(output: unknown) {
	if (typeof output === "string") return output;
	try {
		return JSON.stringify(output) ?? "";
	} catch {
		return String(output);
	}
}

/**
 * Validates the arguments like a model's call, runs the tool, and builds the
 * MCP reply: text, or text and image blocks when the tool's model output has
 * images. A tool reporting `blocked: true` failed. Throws when the arguments
 * are invalid or the tool throws; the caller reports that as an error reply.
 */
export async function runToolForMcp(
	definition: Tool,
	name: string,
	args: Record<string, unknown>,
	options: { readonly toolCallId: string; readonly signal: AbortSignal },
): Promise<{ output: unknown; failed: boolean; reply: McpCallResult }> {
	if (!definition.execute) throw new Error(`Unknown tool: ${name}`);
	const validate = asSchema(definition.inputSchema).validate;
	const parsed = validate ? await validate(args) : undefined;
	if (parsed && !parsed.success)
		throw new Error(`Invalid arguments for ${name}: ${parsed.error.message}`);
	const input = parsed?.success ? parsed.value : args;
	const output = await (definition.execute as NonNullable<Tool["execute"]>)(
		input,
		{
			toolCallId: options.toolCallId,
			messages: [],
			abortSignal: options.signal,
			context: {},
		} as ExecuteOptions,
	);
	if (output && typeof output === "object" && Symbol.asyncIterator in output)
		throw new Error(`${name} streams and cannot run here.`);
	const failed =
		(output as { blocked?: unknown } | null | undefined)?.blocked === true;
	const content = failed
		? undefined
		: await modelContentBlocks(definition, {
				toolCallId: options.toolCallId,
				input,
				output,
			}).catch(() => undefined);
	return {
		output,
		failed,
		reply: {
			text: content ? "" : outputText(output),
			isError: failed,
			...(content ? { content } : {}),
		},
	};
}
