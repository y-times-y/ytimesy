import { createContext, Fragment, useContext } from "react";
import {
	agentNameSegments,
	type MentionAgent,
	type MentionSegment,
	mentionSegments,
} from "#/domain/agent-mentions";
import type { ThreadDirectory } from "#/domain/thread-label";
import { AgentIcon } from "./agent-icon";
import { ReferenceContext, ThreadChip } from "./agent-reference-chips";

/**
 * The chat's agents a view can name (never the view's own) and how to open
 * one. Replies and user messages show their names as chips, like files.
 */
export type AgentMentions = {
	readonly agents: readonly MentionAgent[];
	/** Opens the agent's tab (its agents-list row). */
	readonly onOpen?: (agent: MentionAgent) => void;
};

export const AgentMentionContext = createContext<AgentMentions | null>(null);

/** An agent's name as a file-style chip: its icon in its colour, its name in plain text. */
export function AgentChip({
	agent,
	onOpen,
}: {
	agent: MentionAgent;
	onOpen?: (agent: MentionAgent) => void;
}) {
	const chip = (
		<span className="session-file-chip agent-chip">
			<AgentIcon icon={agent.icon} color={agent.color} size={14} />
			<span className="session-file-name">{agent.name}</span>
		</span>
	);
	if (!onOpen) return chip;
	return (
		<button
			type="button"
			className="session-file-open"
			title={
				agent.task ? `Open ${agent.name} · ${agent.task}` : `Open ${agent.name}`
			}
			onClick={() => onOpen(agent)}
		>
			{chip}
		</button>
	);
}

/** Segments as text and chips; `open` false inside something already clickable. */
export function AgentSegments({
	segments,
	open = true,
	threads,
}: {
	segments: readonly MentionSegment[];
	open?: boolean;
	/** The project's threads: a mention that names one is a thread chip, with its picture. */
	threads?: ThreadDirectory;
}) {
	const mentions = useContext(AgentMentionContext);
	const byName = new Map(
		mentions?.agents.map((agent) => [agent.name.toLowerCase(), agent]) ?? [],
	);
	return (
		<>
			{segments.map((segment, index) => {
				const agent =
					segment.kind === "mention"
						? byName.get(segment.name.toLowerCase())
						: undefined;
				const thread =
					!agent && segment.kind === "mention"
						? threads?.get(segment.name.toLowerCase())
						: undefined;
				if (thread && segment.kind === "mention")
					return (
						<ThreadChip
							// biome-ignore lint/suspicious/noArrayIndexKey: a text's segments keep their order
							key={index}
							id={thread.id}
							label={segment.name}
							threadNumber={thread.threadNumber}
							title={thread.title}
						/>
					);
				return agent ? (
					<AgentChip
						// biome-ignore lint/suspicious/noArrayIndexKey: a text's segments keep their order
						key={index}
						agent={agent}
						onOpen={open ? mentions?.onOpen : undefined}
					/>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: a text's segments keep their order
					<Fragment key={index}>
						{segment.kind === "text" ? segment.text : `@${segment.name}`}
					</Fragment>
				);
			})}
		</>
	);
}

/** A user message's text, its @mentions of the view's other agents and the project's threads as chips. */
export function MentionText({ text }: { text: string }) {
	const mentions = useContext(AgentMentionContext);
	const threads = useContext(ReferenceContext)?.threads;
	if ((!mentions?.agents.length && !threads?.size) || !text.includes("@"))
		return <>{text}</>;
	const names = new Set(
		mentions?.agents.map((agent) => agent.name.toLowerCase()),
	);
	return (
		<span className="mention-text">
			<AgentSegments
				segments={mentionSegments(
					text,
					(name) =>
						names.has(name.toLowerCase()) ||
						Boolean(threads?.has(name.toLowerCase())),
				)}
				threads={threads}
			/>
		</span>
	);
}

/** The names of the view's other agents, for replies (exact case). */
export function useAgentNames(): ReadonlySet<string> {
	const mentions = useContext(AgentMentionContext);
	return new Set(mentions?.agents.map((agent) => agent.name) ?? []);
}

/** Plain text that names the view's other agents ("build-1"), with chips. */
export function AgentNameText({
	text,
	open = true,
}: {
	text: string;
	open?: boolean;
}) {
	const names = useAgentNames();
	return (
		<AgentSegments segments={agentNameSegments(text, names)} open={open} />
	);
}
