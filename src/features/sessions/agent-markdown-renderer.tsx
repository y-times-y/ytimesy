import {
	Children,
	type ComponentProps,
	isValidElement,
	type ReactNode,
	useContext,
	useMemo,
} from "react";
import "streamdown/styles.css";
import {
	CodeBlock,
	type Components,
	defaultRehypePlugins,
	defaultUrlTransform,
	Streamdown,
} from "streamdown";
import {
	agentNameInCode,
	agentNameSegments,
	type MentionAgent,
} from "#/domain/agent-mentions";
import type { FileChangeEntry } from "#/domain/session-item";
import { workspaceFileMention } from "#/domain/workspace-file-mention";
import { AgentChip, AgentMentionContext } from "./agent-chip";
import { codeHighlighter } from "./code-highlighter";
import { FileMentionButton, mentionedFileChange } from "./file-mention";

// Workspace-relative links use our IDE handler; keep sanitization and apply
// the link/image policy below instead of harden's web-only URL resolution.
const markdownPlugins = [
	defaultRehypePlugins.raw,
	defaultRehypePlugins.sanitize,
];

type RehypePlugins = NonNullable<
	ComponentProps<typeof Streamdown>["rehypePlugins"]
>;

/** The attribute that marks an agent name in prose (agentNamePlugin). */
const AGENT_NAME = "data-agent-name";

type HastNode = {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: HastNode[];
};

/**
 * After sanitizing: the view's other agents' names in prose ("build-1",
 * "@research-2") become marked spans, drawn as chips. Code, links and
 * buttons keep their text. Streamdown caches processors by plugin name and
 * options, so the names go in as options.
 */
function rehypeAgentNames(options: { readonly names: readonly string[] }) {
	const names = new Set(options.names);
	const skip = new Set(["code", "pre", "a", "button"]);
	const visit = (node: HastNode) => {
		if (!node.children) return;
		node.children = node.children.flatMap((child): HastNode[] => {
			if (child.type === "element") {
				if (!skip.has(child.tagName ?? "")) visit(child);
				return [child];
			}
			if (child.type !== "text" || !child.value) return [child];
			const segments = agentNameSegments(child.value, names);
			if (segments.length === 1 && segments[0]?.kind === "text") return [child];
			return segments.map((segment) =>
				segment.kind === "text"
					? { type: "text", value: segment.text }
					: {
							type: "element",
							tagName: "span",
							properties: { dataAgentName: segment.name },
							children: [{ type: "text", value: segment.name }],
						},
			);
		});
	};
	return (tree: HastNode) => visit(tree);
}

export function AgentMarkdown({
	text,
	streaming = false,
	fileChanges = [],
	onOpenFile,
	fileMentions = true,
}: {
	text: string;
	streaming?: boolean;
	fileChanges?: readonly FileChangeEntry[];
	onOpenFile?: (path: string) => void;
	/** Off for text that is not about this workspace, such as GitHub comments. */
	fileMentions?: boolean;
}) {
	const mentions = useContext(AgentMentionContext);
	const agents = mentions?.agents;
	const onOpenAgent = mentions?.onOpen;
	const agentNames = useMemo(
		() => new Set(agents?.map((agent) => agent.name) ?? []),
		[agents],
	);
	const rehypePlugins = useMemo<RehypePlugins>(
		() =>
			agentNames.size
				? [
						...markdownPlugins,
						[rehypeAgentNames, { names: [...agentNames].sort() }],
					]
				: markdownPlugins,
		[agentNames],
	);
	const components = useMemo<Components>(() => {
		const agentByName = new Map<string, MentionAgent>(
			agents?.map((agent) => [agent.name, agent]) ?? [],
		);
		function agentChip(name: string) {
			const agent = agentByName.get(name);
			return agent ? <AgentChip agent={agent} onOpen={onOpenAgent} /> : null;
		}
		function fileLink(path: string, label: string) {
			const change = mentionedFileChange(path, fileChanges);
			return (
				<FileMentionButton
					path={change?.path ?? path}
					name={label}
					onOpenFile={onOpenFile}
				/>
			);
		}
		return {
			a: ({ href, children }) => {
				const file = fileMentions && workspaceFileMention(href ?? "");
				if (file)
					return fileLink(file, typeof children === "string" ? children : file);
				const safe = safeExternalLink(href);
				return safe ? (
					<a href={safe} target="_blank" rel="noopener noreferrer">
						{children}
					</a>
				) : (
					<span>{children}</span>
				);
			},
			code: (props) => {
				const { children, className } = props;
				const text = markdownChildText(children);
				if (!("data-block" in props)) {
					const file = fileMentions && workspaceFileMention(text);
					if (file) return fileLink(file, text);
					const agent = agentNameInCode(text, agentNames);
					return (agent && agentChip(agent)) || <code>{children}</code>;
				}
				return (
					<CodeBlock
						code={text}
						lineNumbers={false}
						language={className?.replace(/^language-/, "") ?? "text"}
					/>
				);
			},
			span: ({ node: _node, ...props }) => {
				const name = (props as Record<string, unknown>)[AGENT_NAME];
				return (
					(typeof name === "string" && agentChip(name)) || <span {...props} />
				);
			},
			img: ({ src, alt }) => {
				const safe = safeExternalLink(
					typeof src === "string" ? src : undefined,
				);
				return safe ? (
					<a href={safe} target="_blank" rel="noopener noreferrer">
						{alt || "View image"}
					</a>
				) : (
					<span>{alt || "Image"}</span>
				);
			},
		};
	}, [fileChanges, onOpenFile, fileMentions, agents, agentNames, onOpenAgent]);
	return (
		<Streamdown
			className="session-markdown"
			mode={streaming ? "streaming" : "static"}
			isAnimating={streaming}
			animated={streaming}
			components={components}
			plugins={{ code: codeHighlighter }}
			rehypePlugins={rehypePlugins}
			controls={false}
			skipHtml
			urlTransform={defaultUrlTransform}
		>
			{text}
		</Streamdown>
	);
}

function safeExternalLink(href: string | undefined) {
	return href && /^(https?:\/\/|mailto:|#)/i.test(href) ? href : null;
}

function markdownChildText(children: ReactNode): string {
	return Children.toArray(children)
		.map((child) =>
			typeof child === "string" || typeof child === "number"
				? String(child)
				: isValidElement<{ children?: ReactNode }>(child)
					? markdownChildText(child.props.children)
					: "",
		)
		.join("");
}
