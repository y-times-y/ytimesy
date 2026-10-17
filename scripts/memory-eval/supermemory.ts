// The `supermemory` arm of memory-two-chat-eval.ts: Supermemory's Claude Code
// plugin (github.com/supermemoryai/claude-supermemory, plugin/hooks) replayed
// against its API with the plugin's default settings. Eval only: product code
// never talks to Supermemory.
//
//   capture.js (Stop)            -> captureText + addDocument, one document per chat
//   session-start.js             -> profile(q = project name) + sessionStartContext
//   recall-directive.js (prompt) -> profile(q = prompt) + recallContext
//
// Not replicated: the search_memory MCP tool and the context-gatherer agent
// (mid-chat recall; registering their hosted MCP server would store the API
// key in the development database), the "no memories yet" discovery notice
// that only points at that tool, and redactSecrets (fixtures hold no secrets).
import type { SessionItem } from "../../src/domain/session-item";

const BASE_URL = "https://api.supermemory.ai";

/** plugin/hooks/lib/api.js, verbatim: guides extraction for the container. */
export const AGENT_ENTITY_CONTEXT = `Shared coding-agent memory for one software repository.

RULES:
- Try to remember things that a human would remember — a teammate recalls decisions and lessons, not what state the working tree was in
- Preserve durable context that helps a coding agent continue the work
- Condense assistant responses into decisions, outcomes, and reusable knowledge
- Keep user preferences and project facts concise and independently understandable

EXTRACT:
- User preferences, accepted decisions, durable workflows, actions, and learnings
- Architecture: "uses monorepo with turborepo", "API in /apps/api"
- Conventions: "components in PascalCase", "hooks prefixed with use"
- Patterns: "all API routes use withAuth wrapper", "errors thrown as ApiError"
- Setup: "requires .env with DATABASE_URL", "run pnpm db:migrate first"
- Decisions: "chose Drizzle over Prisma for performance", "using RSC for data fetching"

SKIP:
- Transient repo state git already tracks: uncommitted file lists, current branch position, in-flight commit/push status
- Generic assistant suggestions the user did not accept
- Transient command output and low-value implementation chatter
- Granular details that do not help future work`;

/** settings.js DEFAULT_SETTINGS.maxProfileItems. */
export const MAX_PROFILE_ITEMS = 5;
/** recall-directive.js constants. */
export const MIN_PROMPT_LENGTH = 12;
export const MAX_QUERY_LENGTH = 500;
export const MAX_RESULTS = 5;
export const MAX_RESULT_CHARS = 300;
export const MIN_SIMILARITY = 0.55;

export type SearchResult = {
	memory?: string;
	chunk?: string;
	content?: string;
	text?: string;
	title?: string;
	filepath?: string;
	similarity?: number;
};

export type ProfileResponse = {
	profile?: { static?: string[]; dynamic?: string[] };
	searchResults?: { results?: SearchResult[] };
};

/**
 * What capture.js sends for one finished chat with the default settings
 * (includeTools [] and signalExtraction off): the user's text and every
 * assistant text block, no reasoning, no tool calls or results.
 */
export function captureText(
	items: readonly SessionItem[],
	timestamp: string,
): string | null {
	const parts = [`<|turn_start|>${timestamp}`];
	for (const item of items) {
		if (item.kind === "userMessage" && item.text.trim())
			parts.push(`<|start|>user<|message|>${item.text.trim()}<|end|>`);
		else if (item.kind === "agentMessage" && item.text.trim())
			parts.push(`<|start|>assistant<|message|>${item.text.trim()}<|end|>`);
	}
	parts.push("<|turn_end|>");
	const formatted = parts.join("\n\n");
	return formatted.length < 100 ? null : formatted;
}

function resultText(result: SearchResult) {
	return (
		[result.memory, result.chunk, result.content, result.text].find(
			(value) => typeof value === "string" && value.trim(),
		) ?? null
	);
}

/** session-start.js formatContext, including its empty-container text. */
export function sessionStartContext(
	response: ProfileResponse | null,
	containerTag: string,
	projectName: string,
) {
	const statics = (response?.profile?.static ?? []).slice(0, MAX_PROFILE_ITEMS);
	const dynamics = (response?.profile?.dynamic ?? []).slice(
		0,
		MAX_PROFILE_ITEMS,
	);
	if (!statics.length && !dynamics.length)
		return {
			items: 0,
			text: `<supermemory-context>
No previous memories found for this project (container: ${containerTag}).
Memories will be saved as you work.
</supermemory-context>`,
		};
	const sections: string[] = [];
	if (statics.length)
		sections.push(
			`## User Profile (Persistent)\n${statics.map((fact) => `- ◪ ${fact}`).join("\n")}`,
		);
	if (dynamics.length)
		sections.push(
			`## Recent Context\n${dynamics.map((fact) => `- ◪ ${fact}`).join("\n")}`,
		);
	return {
		items: statics.length + dynamics.length,
		text: `<supermemory-context>
Recalled memory for this project (${projectName}). Every line marked ◪ comes from supermemory — when citing one, keep the mark and phrase it naturally (e.g. "◪ last week you told me about X"). If you name the source, say "from supermemory" — never "from memory".
This project's memory container: ${containerTag}

${sections.join("\n\n")}
</supermemory-context>`,
	};
}

/** The prompt recall-directive.js would search with, or null when it skips. */
export function recallQuery(prompt: string) {
	const text = prompt.trim();
	if (text.length < MIN_PROMPT_LENGTH || ["/", "!", "#"].includes(text[0]))
		return null;
	return text.slice(0, MAX_QUERY_LENGTH);
}

/** recall-directive.js's filter: text-bearing, similarity >= 0.55, top 5. */
export function recalledResults(response: ProfileResponse | null) {
	return (response?.searchResults?.results ?? [])
		.filter((result) => resultText(result))
		.filter(
			(result) =>
				!Number.isFinite(result.similarity) ||
				(result.similarity as number) >= MIN_SIMILARITY,
		)
		.slice(0, MAX_RESULTS);
}

/** recall-directive.js formatRecall; null when nothing passed the filter. */
export function recallContext(
	results: readonly SearchResult[],
	containerTag: string,
) {
	if (!results.length) return null;
	const lines = results.map((result) => {
		const text = (resultText(result) ?? "")
			.replace(/\s+/g, " ")
			.slice(0, MAX_RESULT_CHARS);
		const title = result.title?.trim() || null;
		const prefix = title && !text.startsWith(title) ? `${title} — ` : "";
		return `- ◪ ${prefix}${text}${result.filepath ? ` (${result.filepath})` : ""}`;
	});
	return `<supermemory-recall>
◪ Recalled from supermemory for this prompt (relevance-ranked):
${lines.join("\n")}

When one of these shapes your answer, credit it naturally with the ◪ prefix (e.g. "◪ earlier you decided X"); if you name the source, say "from supermemory" — never "from memory". For deeper history, call the supermemory search_memory tool — it defaults to this project's container (${containerTag}). Pass containerTag only to search a different space. Or launch the context-gatherer agent.
</supermemory-recall>`;
}

/** A small client for the endpoints the plugin uses, plus status and cleanup. */
export function supermemoryClient(apiKey: string, baseUrl = BASE_URL) {
	async function call<T>(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 30_000,
	): Promise<T> {
		const response = await fetch(`${baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				"x-sm-source": "claude-code",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`Supermemory ${method} ${path.split("?")[0]} ${response.status}: ${text.slice(0, 200)}`,
			);
		}
		return (await response.json()) as T;
	}
	return {
		/** capture.js addMemory: POST /v3/documents with the plugin's fields. */
		addDocument(
			content: string,
			containerTag: string,
			customId: string,
			metadata: Record<string, string>,
			/** Unset = the API default ("dynamic"), as the plugin sends it. */
			dreaming?: "instant" | "dynamic",
		) {
			return call<{ id: string; status: string }>("POST", "/v3/documents", {
				content,
				containerTag,
				customId,
				entityContext: AGENT_ENTITY_CONTEXT,
				metadata: { sm_source: "claude-code", ...metadata },
				...(dreaming ? { dreaming } : {}),
			});
		},
		document(id: string) {
			return call<{ status?: string; dreamingStatus?: string }>(
				"GET",
				`/v3/documents/${encodeURIComponent(id)}`,
			);
		},
		profile(containerTag: string, q: string) {
			return call<ProfileResponse>("POST", "/v4/profile", {
				containerTag,
				q,
			});
		},
		/** Deletes the container with all its documents and memories. */
		deleteContainer(containerTag: string) {
			return call<{
				deletedDocumentsCount: number;
				deletedMemoriesCount: number;
			}>("DELETE", `/v3/container-tags/${encodeURIComponent(containerTag)}`);
		},
		deleteDocuments(ids: string[]) {
			return call<{ deletedCount: number }>("DELETE", "/v3/documents/bulk", {
				ids,
			});
		},
	};
}

export type SupermemoryClient = ReturnType<typeof supermemoryClient>;

/**
 * Polls until every document is processed (status done, no dreaming in
 * progress), or the deadline. Returns the final statuses.
 */
export async function waitProcessed(
	client: SupermemoryClient,
	ids: readonly string[],
	timeoutMs: number,
	pollMs = 3000,
) {
	const deadline = Date.now() + timeoutMs;
	let statuses: string[] = [];
	for (;;) {
		statuses = await Promise.all(
			ids.map((id) =>
				client.document(id).then(
					(doc) =>
						`${doc.status ?? "unknown"}${doc.dreamingStatus === "dreaming" ? "+dreaming" : ""}`,
					(error: Error) => `error:${error.message.slice(0, 80)}`,
				),
			),
		);
		const settled = statuses.every(
			(status) => status === "done" || status === "failed",
		);
		if (settled || Date.now() > deadline) return { settled, statuses };
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** The API key from the environment or .secrets/supermemory.env; never logged. */
export async function supermemoryApiKey() {
	if (process.env.SUPERMEMORY_API_KEY) return process.env.SUPERMEMORY_API_KEY;
	const { readFile } = await import("node:fs/promises");
	const text = await readFile(".secrets/supermemory.env", "utf8").catch(
		() => "",
	);
	const key = /^SUPERMEMORY_API_KEY=["']?([^"'\s]+)/m.exec(text)?.[1];
	if (!key)
		throw new Error(
			"Set SUPERMEMORY_API_KEY or add it to .secrets/supermemory.env.",
		);
	return key;
}
