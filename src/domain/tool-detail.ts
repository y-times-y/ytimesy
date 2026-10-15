import { commandActivityTitle } from "./command-activity-title";
import { redactSecrets } from "./project-workspace";
import type { DynamicToolCallItem } from "./session-item";

export function toolCommand(item: DynamicToolCallItem): string | null {
	if (!item.input) return null;
	try {
		const input = JSON.parse(item.input);
		return typeof input.command === "string" ? input.command : null;
	} catch {
		return null;
	}
}

export function toolOutputText(output: string): string {
	try {
		let value = JSON.parse(output);
		if (value?.type === "text" && typeof value.value === "string")
			return value.value;
		if (value?.type === "json") value = value.value;
		if (typeof value?.stdout === "string" || typeof value?.stderr === "string")
			return [
				value.stdout,
				value.stderr,
				typeof value.exitCode === "number" ? `exit ${value.exitCode}` : null,
			]
				.filter(Boolean)
				.join("\n");
		return JSON.stringify(value, null, 2) ?? output;
	} catch {
		return output;
	}
}

export function toolDetailTitle(item: DynamicToolCallItem): string {
	const name = item.tool.replaceAll("_", " ");
	if (!item.input) return name;
	try {
		const input = JSON.parse(item.input);
		if (typeof input.command === "string")
			return commandActivityTitle(input.command);
		const detail = input.path ?? input.query ?? input.title;
		return typeof detail === "string"
			? `${name} · ${detail.replace(/\s+/g, " ").slice(0, 100)}`
			: name;
	} catch {
		return name;
	}
}

/** Public tool evidence is bounded and never includes credential-shaped fields. */
export function publicToolDetail(
	value: unknown,
	format: "structured" | "output" = "structured",
): string {
	const text =
		typeof value === "string"
			? value
			: (JSON.stringify(
					value,
					(key, entry) =>
						/^(authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(
							key,
						)
							? "[redacted]"
							: entry,
					2,
				) ?? "No output");
	const safe = redactSecrets(format === "output" ? toolOutputText(text) : text)
		.replace(/\bsk-[\w-]{12,}/g, "[redacted]")
		.replace(/\bAIza[\w-]{20,}/g, "[redacted]")
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(["'])(.*?)\2/gi,
			"$1$2[redacted]$2",
		)
		.replace(
			/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)["']?\s*[:=]\s*)(?!["'])[^\s,"'}]+/gi,
			"$1[redacted]",
		);
	return safe.length > 16000
		? `${safe.slice(0, 16000)}\n[Output truncated for display]`
		: safe;
}

/** A tool row as a short sentence: "Ran `make test`", "Edited lsm_db.h +12 −3". */
type ToolActivity = {
	verb: string;
	target?: string;
	/** Commands and paths render in monospace. */
	code?: boolean;
	added?: number;
	removed?: number;
	note?: string;
	glyph?:
		| "wait"
		| "message"
		| "image"
		| "guide"
		| "stop"
		| "test"
		| "read"
		| "search";
};

/** What a command mostly does, for its icon. */
function commandGlyph(display: string): ToolActivity["glyph"] {
	const first = display.split(" · ")[0] ?? "";
	if (
		/\b(?:make\s+(?:-C\s+\S+\s+)?(?:test|check)|pytest|vitest|jest|cargo test|go test|npm (?:run )?test|pnpm (?:run )?test|bun test|ctest)\b/.test(
			display,
		)
	)
		return "test";
	if (/^(?:rg|grep|find|ls|fd)\b/.test(first)) return "search";
	if (/^(?:cat|sed|head|tail|wc|less|nl|for \w+ in)\b/.test(first))
		return "read";
	return undefined;
}

const basename = (path: string) =>
	path.split("/").filter(Boolean).at(-1) ?? path;
const clip = (text: string, length = 90) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

/** The command a person would recognize: drop cd/set -e preambles, name heredoc scripts. */
export function displayCommand(command: string): string {
	let text = command.trim();
	for (;;) {
		const next = text
			.replace(/^set -[a-z]+\s*(?:\n|;|&&)\s*/i, "")
			.replace(/^cd\s+\S+\s*(?:&&|;|\n)\s*/, "")
			.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
		if (next === text) break;
		text = next;
	}
	const heredoc =
		/^(\S*python\S*|node|bash|sh|ruby|perl)\b[^\n]*<<-?\s*'?(\w+)'?/.exec(text);
	if (heredoc) {
		const lines = text.split("\n").length - 2;
		return `${basename(heredoc[1])} script · ${Math.max(1, lines)} lines`;
	}
	// Compound commands: keep the parts that do something, drop separators and
	// orientation noise, so similar-looking rows differ by what they ran.
	const parts = text
		.split(/\s*(?:&&|\|\||;|\n)\s*/)
		.map((part) => part.trim())
		.filter(
			(part) =>
				part &&
				!/^(?:pwd|true|:|set -[a-z]+|cd\s+\S+|git status(?: --short| -s)?|printf\s+['"].*|echo\s+['"]?-{2,}.*|[a-z_]+_status=\$\?)$/i.test(
					part,
				),
		);
	return clip(
		(parts.length ? parts : [text.split("\n")[0]]).slice(0, 3).join(" · "),
	);
}

function patchStats(diff: string) {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { added, removed };
}

function parsedJson(text: string | undefined): Record<string, unknown> | null {
	if (!text) return null;
	try {
		const value = JSON.parse(text);
		return value && typeof value === "object" ? value : null;
	} catch {
		return null;
	}
}

const sentence = (name: string) => {
	const words = name.replaceAll("_", " ").trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
};

export function toolActivity(item: DynamicToolCallItem): ToolActivity {
	const input = parsedJson(item.input) ?? {};
	const output = parsedJson(item.output);
	const text = (key: string) =>
		typeof input[key] === "string" ? (input[key] as string) : undefined;
	const tool = item.tool;
	const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
	if (mcp) return { verb: mcp[1], target: mcp[2].replaceAll("_", " ") };
	switch (tool) {
		case "execute_command":
		case "bash":
		case "start_command":
		case "shell": {
			const command = text("command");
			if (!command) return { verb: "Ran command" };
			const display = displayCommand(command);
			return {
				verb: "Ran",
				target: display,
				code: true,
				glyph: commandGlyph(display),
			};
		}
		case "continue_command":
		case "read_command":
		case "wait_command":
			return { verb: "Waited for command output", glyph: "wait" };
		case "stop_command":
			return { verb: "Stopped command", glyph: "stop" };
		case "apply_patch": {
			const operation = (input.operation ?? {}) as Record<string, unknown>;
			const patch =
				typeof operation.diff === "string"
					? operation.diff
					: (text("patch") ?? text("input") ?? "");
			const path =
				typeof operation.path === "string"
					? operation.path
					: (text("path") ??
						/\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(patch)?.[1] ??
						/^\+\+\+ (?:b\/)?(?!\/dev\/null)(\S+)/m.exec(patch)?.[1]);
			const kind = String(operation.type ?? "");
			const verb =
				/create|add/.test(kind) ||
				/\*\*\* Add File|^(?:---|\*\*\*) \/dev\/null/m.test(patch)
					? "Created"
					: /delete/.test(kind) || /\*\*\* Delete File/.test(patch)
						? "Deleted"
						: "Edited";
			return {
				verb,
				target: path ? basename(path) : undefined,
				code: true,
				...patchStats(patch),
			};
		}
		case "replace_text":
		case "write_file":
			return {
				verb: "Edited",
				target: text("path") ? basename(text("path") as string) : undefined,
				code: true,
			};
		case "read_repository_guidance": {
			const scope = text("scope");
			return {
				verb: "Read repository guidance",
				target: scope && scope !== "." ? scope : undefined,
				code: true,
				glyph: "guide",
			};
		}
		case "read_environment_report":
			return { verb: "Read environment report", glyph: "guide" };
		case "view_image":
			return {
				verb: "Viewed",
				target: text("path") ? basename(text("path") as string) : "image",
				code: true,
				glyph: "image",
			};
		case "web_search":
		case "google_search": {
			// Provider-hosted search: the query is in the input (Anthropic) or the result's action (OpenAI).
			const action =
				output && typeof output.action === "object" && output.action
					? (output.action as Record<string, unknown>)
					: undefined;
			const queries = Array.isArray(action?.queries)
				? (action.queries as unknown[]).filter(
						(query): query is string => typeof query === "string",
					)
				: [];
			const query =
				text("query") ??
				(typeof action?.query === "string" ? action.query : queries[0]);
			const url = typeof action?.url === "string" ? action.url : undefined;
			// Searches known only from their cited sources (OpenRouter).
			const cited = Array.isArray(output?.sources) ? output.sources.length : 0;
			return {
				verb: url ? "Opened" : "Searched the web",
				target: url ?? (query ? clip(query, 80) : undefined),
				note:
					queries.length > 1
						? `${queries.length} queries`
						: cited
							? `${cited} ${cited === 1 ? "source" : "sources"}`
							: undefined,
				glyph: "search",
			};
		}
		case "read_plugin_skill":
			return {
				verb: "Read skill",
				target: text("name"),
				code: true,
				glyph: "guide",
			};
	}
	const detail = text("path") ?? text("query") ?? text("title");
	return {
		verb: sentence(tool),
		target: detail ? clip(detail, 80) : undefined,
		code: Boolean(text("path")),
	};
}
