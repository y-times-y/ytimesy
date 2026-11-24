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
import type { ThreadDirectory } from "#/domain/thread-label";
import {
	type FileReference,
	fileReferenceLabel,
	sharedFileNames,
	workspaceFileReference,
} from "#/domain/workspace-file-mention";
import { AgentChip, AgentMentionContext } from "./agent-chip";
import {
	EventLine,
	IssueChip,
	NumberChip,
	PullRequestChip,
	ReferenceContext,
	StatusParagraph,
	ThreadChip,
} from "./agent-reference-chips";
import {
	eventMarker,
	fitsEventLine,
	ISSUE_SCHEME,
	isEventKind,
	issueReference,
	NUMBER_SCHEME,
	numberReference,
	PULL_REQUEST_SCHEME,
	pullRequestReference,
	referenceSegments,
	statusMarker,
	THREAD_SCHEME,
	threadReference,
	withEventLinesAsParagraphs,
} from "./agent-references";
import { codeHighlighter } from "./code-highlighter";
import { FileMentionButton, mentionedFileChange } from "./file-mention";

type SanitizeSchema = { protocols?: Record<string, string[]> };

/** Streamdown's sanitizer, also keeping `thread:` and `pr:` links (agent-references.ts). */
function sanitizeKeepingReferences() {
	const [plugin, schema = {}] = defaultRehypePlugins.sanitize as [
		unknown,
		SanitizeSchema?,
	];
	return [
		plugin,
		{
			...schema,
			protocols: {
				...schema.protocols,
				href: [
					...(schema.protocols?.href ?? []),
					THREAD_SCHEME,
					PULL_REQUEST_SCHEME,
					ISSUE_SCHEME,
					NUMBER_SCHEME,
				],
			},
		},
	] as RehypePlugins[number];
}

// Workspace-relative links use our IDE handler; keep sanitization and apply
// the link/image policy below instead of harden's web-only URL resolution.
const markdownPlugins = [defaultRehypePlugins.raw, sanitizeKeepingReferences()];

const REFERENCE_LINK = new RegExp(
	`^(${THREAD_SCHEME}|${PULL_REQUEST_SCHEME}|${ISSUE_SCHEME}|${NUMBER_SCHEME}):`,
	"i",
);

/** Streamdown's URL policy, letting `thread:` and `pr:` links through to the `a` component. */
const urlTransform: typeof defaultUrlTransform = (url, key, node) =>
	REFERENCE_LINK.test(url) ? url : defaultUrlTransform(url, key, node);

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

/** "owner/repo#12", the text of a link made from a mention in prose. */
const issueName = (issue: { owner: string; repo: string; number: number }) =>
	`${issue.owner}/${issue.repo}#${issue.number}`;

type ReferenceOptions = {
	readonly defaultRepository?: string | null;
	readonly threads?: ThreadDirectory;
};

/** Cheap pre-check: only text with a possible reference is split. */
const mayReference = (text: string) =>
	text.includes("#") ||
	text.includes("pr:") ||
	// A thread's name: "ytimesy-12", or an old label ("WEB-3F9A").
	/[A-Za-z0-9]-[0-9A-Fa-f]/.test(text);

/**
 * After sanitizing: a paragraph that starts with an event marker
 * (`::finished …`) becomes a div marked as that event, or as a status
 * paragraph when its text is too long for one centered line; one that
 * starts with a status marker (`:needs-you: …`) becomes a status
 * paragraph. The marker is dropped (Streamdown keeps its own paragraphs;
 * divs are ours). A `pr:owner/repo#123` in prose becomes a link to that
 * pull request.
 */
function rehypeReferences(options: ReferenceOptions = {}) {
	const skip = new Set(["code", "pre", "a", "button"]);
	const markEvent = (paragraph: HastNode) => {
		const first = paragraph.children?.[0];
		if (first?.type !== "text" || !first.value) return;
		const event = eventMarker(first.value);
		const status = event ? null : statusMarker(first.value);
		const marker = event ?? status;
		if (!marker) return;
		first.value = first.value.slice(marker.length);
		const text = hastText(paragraph).replace(/\s+/g, " ").trim();
		paragraph.tagName = "div";
		paragraph.properties =
			event && fitsEventLine(text)
				? { ...paragraph.properties, dataEvent: marker.kind, title: text }
				: { ...paragraph.properties, dataStatus: marker.kind };
	};
	const visit = (node: HastNode) => {
		if (!node.children) return;
		node.children = node.children.flatMap((child): HastNode[] => {
			if (child.type === "element") {
				if (child.tagName === "p" && node.type === "root") markEvent(child);
				if (!skip.has(child.tagName ?? "")) visit(child);
				return [child];
			}
			if (child.type !== "text" || !child.value || !mayReference(child.value))
				return [child];
			return referenceSegments(child.value, options).map(
				(segment): HastNode => {
					if (segment.kind === "text")
						return { type: "text", value: segment.text };
					const [href, text] =
						segment.kind === "pullRequest"
							? [segment.pullRequest.url, segment.pullRequest.url]
							: segment.kind === "issue"
								? [segment.issue.url, issueName(segment.issue)]
								: segment.kind === "number"
									? [
											`${NUMBER_SCHEME}:${issueName(segment.number)}`,
											issueName(segment.number),
										]
									: [`${THREAD_SCHEME}:${segment.id}`, segment.label];
					return {
						type: "element",
						tagName: "a",
						properties: { href },
						children: [{ type: "text", value: text }],
					};
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

/** The thread directory without the names this chat's own agents (never a thread) answer to. */
export function withoutAgentNames(
	threads: ThreadDirectory | undefined,
	agents: readonly MentionAgent[] | undefined,
): ThreadDirectory | undefined {
	if (!threads?.size || !agents?.length) return threads;
	const own = new Set(
		agents.filter((agent) => !agent.threadId).map((a) => a.name.toLowerCase()),
	);
	if (![...threads.keys()].some((name) => own.has(name))) return threads;
	return new Map([...threads].filter(([name]) => !own.has(name)));
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
	// Keyed by the names, so a streaming answer rebuilds its chips only when
	// a new shared name appears.
	const sharedKey = [...sharedFileNames(text)].sort().join("\n");
	const sharedNames = useMemo(
		() => new Set(sharedKey ? sharedKey.split("\n") : []),
		[sharedKey],
	);
	const references = useContext(ReferenceContext);
	const defaultRepository = references?.defaultRepository;
	// A name that is both one of this chat's agents and a thread's (a project
	// called "build" has a thread "build-1", and the chat a helper "build-1")
	// reads as the agent, as it does in a user's message: the agent keeps its
	// own icon and only real threads get the Y. An explicit `thread:` link
	// still draws the thread.
	const allThreads = references?.threads;
	const threads = useMemo(
		() => withoutAgentNames(allThreads, agents),
		[allThreads, agents],
	);
	const rehypePlugins = useMemo<RehypePlugins>(
		() => [
			...markdownPlugins,
			[rehypeReferences, { defaultRepository, threads }],
			[rehypeAgentNames, { names: [...agentNames].sort() }],
		],
		[agentNames, defaultRepository, threads],
	);
	const components = useMemo<Components>(() => {
		// A thread has its name and its old label in the directory: the
		// first, the numbered name, is the one a chip shows.
		const labelById = new Map<
			string,
			{ label: string; title: string; threadNumber?: number | null }
		>();
		for (const [label, thread] of allThreads ?? [])
			if (!labelById.has(thread.id))
				labelById.set(thread.id, {
					label,
					title: thread.title,
					threadNumber: thread.threadNumber,
				});
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
				const label = markdownChildText(children);
				const thread = threadReference(href);
				if (thread) {
					const known = labelById.get(thread);
					return (
						<ThreadChip
							id={thread}
							label={known?.label}
							threadNumber={known?.threadNumber}
							title={known && label === known.label ? known.title : children}
						/>
					);
				}
				const bare = numberReference(href);
				if (bare)
					return (
						<NumberChip
							number={bare}
							label={label && label !== issueName(bare) ? children : undefined}
						/>
					);
				const issue = issueReference(href);
				if (issue) {
					const text =
						label &&
						label !== href &&
						label !== issue.url &&
						label !== issueName(issue)
							? children
							: undefined;
					return <IssueChip issue={issue} label={text} />;
				}
				const pullRequest = pullRequestReference(href);
				if (pullRequest)
					return (
						<PullRequestChip
							pullRequest={pullRequest}
							label={
								label && label !== href && label !== pullRequest.url
									? children
									: undefined
							}
						/>
					);
				// A malformed `thread:` or `pr:` reference reads as its text.
				if (REFERENCE_LINK.test(href ?? "")) return <span>{children}</span>;
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
						{linkLabel(label, safe) ?? children}
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
			div: ({ node: _node, children, ...props }) => {
				const data = props as Record<string, unknown>;
				const event = data["data-event"];
				if (isEventKind(event))
					return (
						<EventLine kind={event} title={props.title}>
							{children}
						</EventLine>
					);
				const status = data["data-status"];
				if (isEventKind(status))
					return <StatusParagraph kind={status}>{children}</StatusParagraph>;
				return <div {...props}>{children}</div>;
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
		allThreads,
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
			urlTransform={urlTransform}
		>
			{withEventLinesAsParagraphs(
				streaming
					? withoutDanglingMarker(withoutPullRequestBlock(text))
					: withoutPullRequestBlock(text),
			)}
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
