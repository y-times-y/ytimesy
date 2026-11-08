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
	echoedTaskLength,
	type MentionAgent,
} from "#/domain/agent-mentions";
import { linkLabel } from "#/domain/link-label";
import {
	withoutDanglingMarker,
	withoutPullRequestBlock,
} from "#/domain/markdown-text";
import { readableModelCitations } from "#/domain/model-citation";
import type { FileChangeEntry } from "#/domain/session-item";
import {
	type FileReference,
	fileReferenceLabel,
	sharedFileNames,
	workspaceFileReference,
} from "#/domain/workspace-file-mention";
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
function hastText(node: HastNode): string {
	return node.value ?? (node.children ?? []).map(hastText).join("");
}

function rehypeAgentNames(options: { readonly names: readonly string[] }) {
	const names = new Set(options.names);
	const skip = new Set(["code", "pre", "a", "button"]);
	const visit = (node: HastNode) => {
		if (!node.children) return;
		let previous: HastNode | undefined;
		node.children = node.children.flatMap((child): HastNode[] => {
			const before = previous;
			previous = child;
			if (child.type === "element") {
				if (!skip.has(child.tagName ?? "")) visit(child);
				return [child];
			}
			if (child.type !== "text" || !child.value) return [child];
			child.value = readableModelCitations(child.value);
			// `review-2` ("Audit chat lifecycle"): the chip already names it.
			if (
				before?.type === "element" &&
				before.tagName === "code" &&
				agentNameInCode(hastText(before), names)
			)
				child.value = child.value.slice(echoedTaskLength(child.value));
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

/**
 * New words of a streaming reply fade in as they show; the reply's own
 * pace comes from useSmoothText, so they are not staggered further. A
 * constant: Streamdown compares it by identity.
 */
const NEW_WORDS_FADE = {
	animation: "fadeIn",
	duration: 180,
	stagger: 0,
} as const;

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
	// Keyed by the names, so a streaming answer rebuilds its chips only when
	// a new shared name appears.
	const sharedKey = [...sharedFileNames(text)].sort().join("\n");
	const sharedNames = useMemo(
		() => new Set(sharedKey ? sharedKey.split("\n") : []),
		[sharedKey],
	);
	const rehypePlugins = useMemo<RehypePlugins>(
		() => [
			...markdownPlugins,
			[rehypeAgentNames, { names: [...agentNames].sort() }],
		],
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
		function fileLink(reference: FileReference, label?: string) {
			const change = mentionedFileChange(reference.path, fileChanges);
			return (
				<FileMentionButton
					path={change?.path ?? reference.path}
					name={label ?? fileReferenceLabel(reference, sharedNames)}
					lines={reference.lines}
					onOpenFile={onOpenFile}
				/>
			);
		}
		return {
			a: ({ href, children }) => {
				const file = fileMentions && workspaceFileReference(href ?? "");
				if (file)
					return fileLink(
						file,
						typeof children === "string" && children !== href
							? children
							: undefined,
					);
				const safe = safeExternalLink(href);
				return safe ? (
					<a href={safe} title={safe} target="_blank" rel="noopener noreferrer">
						{linkLabel(markdownChildText(children), safe) ?? children}
					</a>
				) : (
					<span>{children}</span>
				);
			},
			code: (props) => {
				const { children, className } = props;
				const text = markdownChildText(children);
				if (!("data-block" in props)) {
					const file = fileMentions && workspaceFileReference(text);
					if (file) return fileLink(file);
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
	}, [
		fileChanges,
		onOpenFile,
		fileMentions,
		agents,
		agentNames,
		onOpenAgent,
		sharedNames,
	]);
	return (
		<Streamdown
			className="session-markdown"
			mode={streaming ? "streaming" : "static"}
			isAnimating={streaming}
			animated={streaming ? NEW_WORDS_FADE : false}
			components={components}
			plugins={{ code: codeHighlighter }}
			rehypePlugins={rehypePlugins}
			controls={false}
			skipHtml
			urlTransform={defaultUrlTransform}
		>
			{streaming
				? withoutDanglingMarker(withoutPullRequestBlock(text))
				: withoutPullRequestBlock(text)}
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
