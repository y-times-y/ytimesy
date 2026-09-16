import type { AgentInline } from "#/domain/agent-markdown";
import { parseAgentMarkdown } from "#/domain/agent-markdown";
import { fileBasename } from "#/domain/file-kind";
import type { FileChangeEntry } from "#/domain/session-item";
import { sourceLanguageFromFence } from "#/domain/source-language";
import { FileMentionButton, mentionedFileChange } from "./file-mention";
import { HighlightedCode } from "./highlighted-code";

export function AgentMarkdown({
	text,
	fileChanges = [],
	onOpenFile,
}: {
	text: string;
	fileChanges?: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
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
							<code>
								<HighlightedCode
									text={block.text}
									language={sourceLanguageFromFence(block.language)}
								/>
							</code>
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
									<AgentInlines
										inlines={item}
										fileChanges={fileChanges}
										onOpenFile={onOpenFile}
									/>
								</li>
							))}
						</ListTag>
					);
				}
				return (
					<p key={key}>
						<AgentInlines
							inlines={block.inlines}
							fileChanges={fileChanges}
							onOpenFile={onOpenFile}
						/>
					</p>
				);
			})}
		</div>
	);
}

function AgentInlines({
	inlines,
	fileChanges,
	onOpenFile,
}: {
	inlines: readonly AgentInline[];
	fileChanges: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
}) {
	return (
		<>
			{numbered(inlines, (part) => `${part.kind}:${part.text}`).map(
				({ item: part, key }) => {
					if (part.kind === "file") {
						const mentioned = mentionedFileChange(part.path, fileChanges);
						return (
							<FileMentionButton
								key={key}
								path={mentioned?.path ?? part.path}
								name={part.text || fileBasename(part.path)}
								change={mentioned?.change}
								onOpenFile={onOpenFile}
							/>
						);
					}
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
