// The scripted model: a fetch for the Codex subscription backend
// (chatgpt.com/backend-api), installed where the edge installs its egress
// (withCodexSubscriptionEgress), so the whole subscription transport, the
// AI SDK's Responses client and the agent loop run for real. Each agent is
// recognized by its conversation (a script's `match` on the first user
// message) and answers from its script: tool calls with fixed arguments, or
// text. Nothing reaches a model provider.
import { randomUUID } from "node:crypto";

export type ToolCall = { name: string; args: unknown };
export type Reply =
	| { calls: ToolCall[] }
	| { text: string }
	/** A 200 without a body once (rehearses the provider flake), then `then`. */
	| { fault: "empty-body"; after: Reply };

/** What a script sees: its conversation so far. */
export type ScriptContext = {
	/** Our earlier replies in this conversation (0 on the first request). */
	readonly step: number;
	readonly model: string;
	readonly instructions: string;
	readonly tools: readonly string[];
	/** User-role texts in order (the brief, later feedback, runtime notes). */
	readonly userTexts: readonly string[];
	/** Every tool call with its output, in order. */
	readonly calls: readonly { name: string; args: unknown; output: string }[];
	/** Outputs of the previous step's calls. */
	readonly last: readonly { name: string; args: unknown; output: string }[];
	/** Earlier assistant texts. */
	readonly texts: readonly string[];
};

export type AgentScript = {
	readonly name: string;
	/** Picks the conversation by its user messages (joined). */
	readonly match: (firstUserText: string, model: string) => boolean;
	readonly reply: (context: ScriptContext) => Reply;
};

export type ModelRequestRecord = {
	agent: string;
	model: string;
	step: number;
	tools: string[];
	reply: Reply;
	/** The newest user-role message this request carried. */
	lastUser: string;
	/** Every user-role message this request carried, in order. */
	users: string[];
	/** The request's prompt_cache_key (one per agent session). */
	cacheKey: string | null;
	/** The system instructions the agent was given. */
	instructions: string;
	/** The first user-role message (the task or brief). */
	firstUser: string;
	/** The reasoning effort the request asked for. */
	effort: string | null;
	/** Outputs of the previous step's tool calls, as the model read them. */
	lastOutputs: string[];
	at: number;
};

const CATALOG = ["gpt-6.1-sol", "gpt-6-luna"].map((slug, priority) => ({
	slug,
	display_name: slug,
	visibility: "list",
	supported_reasoning_levels: [
		{ effort: "low" },
		{ effort: "medium" },
		{ effort: "high" },
	],
	default_reasoning_level: "medium",
	priority,
	context_window: 272_000,
	auto_compact_token_limit: 240_000,
}));

type InputItem = {
	type?: string;
	role?: string;
	content?: unknown;
	call_id?: string;
	name?: string;
	arguments?: string;
	input?: string;
	output?: unknown;
};

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: typeof (part as { text?: unknown }).text === "string"
						? (part as { text: string }).text
						: "",
			)
			.join("");
	return "";
}

function outputText(output: unknown): string {
	if (typeof output === "string") return output;
	return text(output) || JSON.stringify(output);
}

export class FakeCodex {
	readonly requests: ModelRequestRecord[] = [];
	readonly unmatched: string[] = [];
	private faults = new Set<string>();
	readonly faultsSent: string[] = [];
	constructor(private readonly scripts: AgentScript[]) {}

	readonly fetch: typeof fetch = async (input, init) => {
		const url = new URL(
			typeof input === "string" || input instanceof URL ? input : input.url,
		);
		if (url.pathname.endsWith("/codex/models"))
			return Response.json({ models: CATALOG });
		if (url.pathname.endsWith("/wham/usage"))
			return Response.json({ rate_limit: null });
		if (!url.pathname.endsWith("/codex/responses"))
			return new Response("not found", { status: 404 });
		const body = JSON.parse(String(init?.body ?? "{}")) as {
			model: string;
			instructions?: string;
			input: InputItem[];
			tools?: { name?: string; type?: string }[];
			prompt_cache_key?: string;
			reasoning?: { effort?: string };
		};
		return this.respond(body);
	};

	private respond(body: {
		model: string;
		instructions?: string;
		input: InputItem[];
		tools?: { name?: string; type?: string }[];
		prompt_cache_key?: string;
		reasoning?: { effort?: string };
	}): Response {
		const userTexts: string[] = [];
		const texts: string[] = [];
		const calls: { id: string; name: string; args: unknown; output: string }[] =
			[];
		const byId = new Map<string, (typeof calls)[number]>();
		const seenSteps: string[] = [];
		for (const item of body.input) {
			if (item.type === "function_call" || item.type === "custom_tool_call") {
				const id = item.call_id ?? "";
				const tag = /^rh_(\d+_[0-9a-f]+)_\d+$/.exec(id);
				if (tag && !seenSteps.includes(tag[1])) seenSteps.push(tag[1]);
				let args: unknown = item.arguments ?? item.input;
				try {
					args = JSON.parse(String(args));
				} catch {}
				const call = { id, name: item.name ?? "", args, output: "" };
				calls.push(call);
				byId.set(id, call);
			} else if (
				item.type === "function_call_output" ||
				item.type === "custom_tool_call_output"
			) {
				const call = byId.get(item.call_id ?? "");
				if (call) call.output = outputText(item.output);
			} else if (item.role === "user") {
				userTexts.push(text(item.content));
			} else if (item.role === "assistant") {
				const said = text(item.content);
				if (said) texts.push(said);
			}
		}
		const step = seenSteps.length + texts.length;
		// The task or brief is not always the first user message (the runtime
		// may put context first), so scripts match on every user message.
		const first = userTexts.join("\n\n");
		const script = this.scripts.find((candidate) =>
			candidate.match(first, body.model),
		);
		if (!script) {
			this.unmatched.push(first.slice(0, 400));
			return this.stream(
				body.model,
				{
					text: "No rehearsal script matched this conversation.",
				},
				"unmatched",
				step,
			);
		}
		const lastStep = seenSteps.at(-1);
		const last = lastStep
			? calls.filter((call) => call.id.startsWith(`rh_${lastStep}_`))
			: [];
		const reply = script.reply({
			step,
			model: body.model,
			instructions: body.instructions ?? "",
			tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? ""),
			userTexts,
			calls,
			last,
			texts,
		});
		this.requests.push({
			agent: script.name,
			model: body.model,
			step,
			tools: (body.tools ?? []).map((tool) => tool.name ?? tool.type ?? ""),
			reply,
			lastUser: userTexts.at(-1) ?? "",
			users: userTexts,
			cacheKey: body.prompt_cache_key ?? null,
			instructions: body.instructions ?? "",
			firstUser: userTexts[0] ?? "",
			effort: body.reasoning?.effort ?? null,
			lastOutputs: last.map((call) => call.output),
			at: Date.now(),
		});
		if ("fault" in reply) {
			// The fault fires once per agent and step; the resend gets `after`.
			const key = `${script.name}:${step}`;
			if (!this.faults.has(key)) {
				this.faults.add(key);
				this.faultsSent.push(key);
				return new Response(null, { status: 200 });
			}
			return this.stream(body.model, reply.after, script.name, step);
		}
		return this.stream(body.model, reply, script.name, step);
	}

	private stream(model: string, reply: Reply, _agent: string, step: number) {
		const events: unknown[] = [
			{
				type: "response.created",
				response: { id: `resp_${randomUUID()}`, created_at: 1, model },
			},
		];
		if ("fault" in reply) throw new Error("Nested rehearsal faults.");
		if ("calls" in reply) {
			// Unique per conversation step, so the next request can count steps.
			const run = randomUUID().slice(0, 8);
			reply.calls.forEach((call, index) => {
				const item = {
					type: "function_call",
					id: `fc_${randomUUID()}`,
					call_id: `rh_${step}_${run}_${index}`,
					name: call.name,
					arguments: JSON.stringify(call.args),
				};
				events.push(
					{
						type: "response.output_item.added",
						output_index: index,
						item: { ...item, arguments: "" },
					},
					{
						type: "response.function_call_arguments.delta",
						item_id: item.id,
						output_index: index,
						delta: item.arguments,
					},
					{
						type: "response.output_item.done",
						output_index: index,
						item: { ...item, status: "completed" },
					},
				);
			});
		} else if ("text" in reply) {
			const id = `msg_${randomUUID()}`;
			events.push(
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id },
				},
				{ type: "response.output_text.delta", item_id: id, delta: reply.text },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: { type: "message", id },
				},
			);
		}
		events.push({
			type: "response.completed",
			response: {
				usage: {
					input_tokens: 1000 + step * 100,
					input_tokens_details: { cached_tokens: step ? 800 : 0 },
					output_tokens: 50,
					output_tokens_details: { reasoning_tokens: 10 },
				},
			},
		});
		return new Response(
			events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
			{ headers: { "Content-Type": "text/event-stream" } },
		);
	}
}
