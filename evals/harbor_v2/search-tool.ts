import { type ToolSet, tool } from "ai";
import { z } from "zod";

/**
 * search=function: web search as a plain function tool. The provider's
 * hosted search tool adds ~2.9K hidden input tokens to every request it is
 * offered in (Bedrock Astra, measured 2026-10-27), searching or not; here
 * only the call's own request carries it. The description depends on
 * nothing, so it is byte-stable across steps and runs.
 */
export const FUNCTION_SEARCH_TOOL = "web_search";

/** The instructions of a web_search call's own request. */
export const SEARCH_REQUEST_INSTRUCTIONS =
	"Search the web for the query and answer with the relevant findings and their source URLs, at most 300 words. No preamble.";

export function functionWebSearchTool(input: {
	/** One separate request with the hosted search tool; returns its answer. */
	search: (query: string, signal: AbortSignal | undefined) => Promise<string>;
}): ToolSet {
	return {
		[FUNCTION_SEARCH_TOOL]: tool({
			description:
				"Search the web; returns findings with source URLs. Use for docs, APIs or facts not in the workspace.",
			inputSchema: z.object({
				query: z.string().min(1).max(1_000).describe("What to search for"),
			}),
			execute: async ({ query }, options) => {
				try {
					const answer = (
						await input.search(query, options.abortSignal)
					).trim();
					return answer || "Search returned no findings; rephrase the query.";
				} catch (error) {
					return `Search failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}. Retry with a different query, or work without it.`;
				}
			},
		}),
	};
}
