import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { type MemoryFiles, memoryPath } from "#/domain/memory-repo";

const READ_LINES = 200;
const SEARCH_HITS = 60;

/**
 * The read side of the memory repo as two tools over its files: a regex search
 * over every line and a line-range read. The dreamer uses them on its writable
 * copy; a subagent uses them, under their own names, on the chat's scope of
 * the snapshot, so it can find what it needs without a VM or a clone.
 */
export function memoryReadTools(
	files: () => Promise<MemoryFiles> | MemoryFiles,
	names: { search: string; read: string } = {
		search: "search",
		read: "read_file",
	},
): ToolSet {
	return {
		[names.search]: tool({
			description: `Search every memory line with a case-insensitive regular expression. Returns path:line: text for up to ${SEARCH_HITS} lines.`,
			inputSchema: z.object({ pattern: z.string().min(1).max(200) }),
			execute: async ({ pattern }) => {
				let regex: RegExp;
				try {
					regex = new RegExp(pattern, "i");
				} catch {
					regex = new RegExp(
						pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
						"i",
					);
				}
				const hits = Object.entries(await files()).flatMap(([path, content]) =>
					content
						.split("\n")
						.flatMap((line, index) =>
							regex.test(line) ? [`${path}:${index + 1}: ${line}`] : [],
						),
				);
				return hits.slice(0, SEARCH_HITS).join("\n") || "no matches";
			},
		}),
		[names.read]: tool({
			description: `Read lines of a memory file (1-based, at most ${READ_LINES} lines per call).`,
			inputSchema: z.object({
				path: z.string(),
				from: z.number().int().min(1).optional(),
				to: z.number().int().min(1).optional(),
			}),
			execute: async ({ path, from = 1, to }) => {
				const relative = memoryPath(path);
				const content = relative ? (await files())[relative] : undefined;
				if (content === undefined) return `no such file: ${path}`;
				const lines = content.split("\n");
				const end = Math.min(
					to ?? from + READ_LINES - 1,
					from + READ_LINES - 1,
				);
				return `${relative} (${lines.length} lines)\n${lines
					.slice(from - 1, end)
					.map((line, index) => `${from + index}: ${line}`)
					.join("\n")}`;
			},
		}),
	};
}
