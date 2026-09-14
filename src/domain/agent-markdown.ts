export type AgentInline =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "strong"; readonly text: string }
	| { readonly kind: "link"; readonly text: string };

export type AgentMarkdownBlock =
	| { readonly kind: "paragraph"; readonly inlines: readonly AgentInline[] }
	| {
			readonly kind: "list";
			readonly ordered: boolean;
			readonly items: readonly (readonly AgentInline[])[];
	  }
	| {
			readonly kind: "code";
			readonly language: string | null;
			readonly text: string;
	  };

export function parseAgentMarkdown(text: string): AgentMarkdownBlock[] {
	const trimmed = text.replace(/\r\n/g, "\n").trim();
	if (!trimmed) return [];
	const blocks: AgentMarkdownBlock[] = [];
	const fence = /```([^\n]*)\n([\s\S]*?)```/g;
	let cursor = 0;
	let match = fence.exec(trimmed);
	while (match) {
		const before = trimmed.slice(cursor, match.index);
		blocks.push(...parseMarkdownBlocks(before));
		blocks.push({
			kind: "code",
			language: fenceLanguage(match[1] ?? ""),
			text: (match[2] ?? "").replace(/\n$/, ""),
		});
		cursor = match.index + match[0].length;
		match = fence.exec(trimmed);
	}
	blocks.push(...parseMarkdownBlocks(trimmed.slice(cursor)));
	return blocks;
}

function parseMarkdownBlocks(text: string): AgentMarkdownBlock[] {
	const blocks: AgentMarkdownBlock[] = [];
	let paragraph: string[] = [];
	let list: string[] = [];

	function flushParagraph() {
		if (paragraph.length === 0) return;
		blocks.push({
			kind: "paragraph",
			inlines: parseInlines(paragraph.join(" ")),
		});
		paragraph = [];
	}

	function flushList() {
		if (list.length === 0) return;
		blocks.push({
			kind: "list",
			ordered: list.some((line) => /^\s*\d+\.\s+/.test(line)),
			items: list.map((line) => parseInlines(listItemText(line) ?? line)),
		});
		list = [];
	}

	for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
		if (!line.trim()) {
			flushList();
			flushParagraph();
			continue;
		}
		if (listItemText(line) !== null) {
			flushParagraph();
			list.push(line);
			continue;
		}
		flushList();
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			flushParagraph();
			blocks.push({
				kind: "paragraph",
				inlines: [{ kind: "strong", text: heading[1] ?? "" }],
			});
			continue;
		}
		paragraph.push(line);
	}
	flushList();
	flushParagraph();
	return blocks;
}

function listItemText(line: string): string | null {
	const match = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)$/);
	return match ? (match[1] ?? "") : null;
}

function parseInlines(text: string): AgentInline[] {
	const inlines: AgentInline[] = [];
	const pattern = /(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)/g;
	let cursor = 0;
	let match = pattern.exec(text);
	while (match) {
		if (match.index > cursor) {
			inlines.push({ kind: "text", text: text.slice(cursor, match.index) });
		}
		const token = match[0];
		if (token.startsWith("[")) {
			const label = token.match(/^\[([^\]]+)\]/)?.[1] ?? token;
			if (label.startsWith("`") && label.endsWith("`") && label.length > 1) {
				inlines.push({ kind: "code", text: label.slice(1, -1) });
			} else {
				inlines.push({ kind: "link", text: label });
			}
		} else if (token.startsWith("`")) {
			inlines.push(inlineFromCode(token.slice(1, -1)));
		} else if (token.startsWith("**")) {
			inlines.push({ kind: "strong", text: token.slice(2, -2) });
		}
		cursor = match.index + token.length;
		match = pattern.exec(text);
	}
	if (cursor < text.length)
		inlines.push({ kind: "text", text: text.slice(cursor) });
	return inlines.length > 0 ? inlines : [{ kind: "text", text }];
}

function inlineFromCode(text: string): AgentInline {
	const wrapped = text.match(/^\[([^\]]+)\]\([^)]+\)$/);
	if (!wrapped?.[1]) return { kind: "code", text };
	const label = wrapped[1];
	if (label.startsWith("`") && label.endsWith("`") && label.length > 1) {
		return { kind: "code", text: label.slice(1, -1) };
	}
	return { kind: "code", text: label };
}

function fenceLanguage(tag: string): string | null {
	const name = tag.trim().split(/\s+/)[0];
	return name || null;
}
