import type { AgentInline } from "#/domain/agent-markdown";
import { parseAgentMarkdown } from "#/domain/agent-markdown";

export function AgentMarkdown({ text }: { text: string }) {
	const blocks = parseAgentMarkdown(text);
	if (blocks.length === 0) return <p>{text}</p>;
	return (
		<div className="session-markdown">
			{numbered(blocks, (block) =>
				block.kind === "code"
					? block.text
					: block.kind === "list"
						? block.items
								.flat()
								.map((part) => part.text)
								.join("")
						: block.inlines.map((part) => part.text).join(""),
			).map(({ item: block, key }) => {
				if (block.kind === "code") {
					return (
						<pre key={key}>
							<code>{block.text}</code>
						</pre>
					);
				}
				if (block.kind === "list") {
					const ListTag = block.ordered ? "ol" : "ul";
					return (
						<ListTag key={key}>
							{numbered(block.items, (item) =>
								item.map((part) => part.text).join(""),
							).map(({ item, key: itemKey }) => (
								<li key={itemKey}>
									<AgentInlines inlines={item} />
								</li>
							))}
						</ListTag>
					);
				}
				return (
					<p key={key}>
						<AgentInlines inlines={block.inlines} />
					</p>
				);
			})}
		</div>
	);
}

function AgentInlines({ inlines }: { inlines: readonly AgentInline[] }) {
	return (
		<>
			{numbered(inlines, (part) => `${part.kind}:${part.text}`).map(
				({ item: part, key }) => {
					if (part.kind === "code") return <code key={key}>{part.text}</code>;
					if (part.kind === "strong")
						return <strong key={key}>{part.text}</strong>;
					return <span key={key}>{part.text}</span>;
				},
			)}
		</>
	);
}

function numbered<T>(
	items: readonly T[],
	identity: (item: T) => string,
): { item: T; key: string }[] {
	const seen = new Map<string, number>();
	return items.map((item) => {
		const base = identity(item);
		const count = (seen.get(base) ?? 0) + 1;
		seen.set(base, count);
		return { item, key: `${base}:${count}` };
	});
}
