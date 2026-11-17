import type { ToolSet } from "ai";
import { Y_TOOLS } from "#/domain/y-agent";

/** Y's tools (src/domain/y-agent.ts): delegation, the user's questions and secret requests only. */
export function yTools(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).filter(([name]) => Y_TOOLS.has(name)),
	);
}
