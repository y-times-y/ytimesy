export type AgentInline =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "strong"; readonly text: string }
	| { readonly kind: "link"; readonly text: string };

export type AgentMarkdownBlock =
	| { readonly kind: "paragraph"; readonly inlines: readonly AgentInline[] }
	| {
			readonly kind: "list";
			readonly items: readonly (readonly AgentInline[])[];
	  }
	| { readonly kind: "code"; readonly text: string };

export function parseAgentMarkdown(text: string): AgentMarkdownBlock[] {
	const trimmed = text.replace(/\r\n/g, "\n").trim();
	if (!trimmed) return [];
	const blocks: AgentMarkdownBlock[] = [];
	const fence = /```[^\n]*\n([\s\S]*?)```/g;
	let cursor = 0;
	let match = fence.exec(trimmed);
	while (match) {
		const before = trimmed.slice(cursor, match.index);
		blocks.push(...parseMarkdownBlocks(before));
		blocks.push({ kind: "code", text: (match[1] ?? "").replace(/\n$/, "") });
		cursor = match.index + match[0].length;
		match = fence.exec(trimmed);
	}
	blocks.push(...parseMarkdownBlocks(trimmed.slice(cursor)));
	return blocks;
}

function parseMarkdownBlocks(text: string): AgentMarkdownBlock[] {
	const chunks = text
		.trim()
		.split(/\n{2,}/)
		.filter((chunk) => chunk.trim());
	const blocks: AgentMarkdownBlock[] = [];
	for (const chunk of chunks) {
		const lines = chunk.split("\n");
		const listLines = lines.filter((line) => /^\s*[-*]\s+/.test(line));
		if (listLines.length === lines.length && lines.length > 0) {
			blocks.push({
				kind: "list",
				items: lines.map((line) =>
					parseInlines(line.replace(/^\s*[-*]\s+/, "")),
				),
			});
			continue;
		}
		blocks.push({
			kind: "paragraph",
			inlines: parseInlines(chunk.replace(/\n/g, " ")),
		});
	}
	return blocks;
}

function parseInlines(text: string): AgentInline[] {
	const inlines: AgentInline[] = [];
	const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
	let cursor = 0;
	let match = pattern.exec(text);
	while (match) {
		if (match.index > cursor) {
			inlines.push({ kind: "text", text: text.slice(cursor, match.index) });
		}
		const token = match[0];
		if (token.startsWith("`")) {
			inlines.push({ kind: "code", text: token.slice(1, -1) });
		} else if (token.startsWith("**")) {
			inlines.push({ kind: "strong", text: token.slice(2, -2) });
		} else {
			const label = token.match(/^\[([^\]]+)\]/)?.[1] ?? token;
			if (label.startsWith("`") && label.endsWith("`") && label.length > 1) {
				inlines.push({ kind: "code", text: label.slice(1, -1) });
			} else {
				inlines.push({ kind: "link", text: label });
			}
		}
		cursor = match.index + token.length;
		match = pattern.exec(text);
	}
	if (cursor < text.length)
		inlines.push({ kind: "text", text: text.slice(cursor) });
	return inlines.length > 0 ? inlines : [{ kind: "text", text }];
}
