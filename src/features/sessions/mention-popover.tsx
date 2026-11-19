import type { CSSProperties } from "react";
import type { MentionAgent } from "#/domain/agent-mentions";
import { threadColor } from "#/domain/thread-color";
import { ThreadMark } from "../workspace/thread-mark";
import { AgentIcon } from "./agent-icon";

/** The "@" popover over the composer: the chat's agents, Main first, then the project's threads. */
export function MentionPopover({
	agents,
	activeIndex,
	onHover,
	onSelect,
}: {
	agents: readonly MentionAgent[];
	activeIndex: number;
	onHover: (index: number) => void;
	onSelect: (agent: MentionAgent) => void;
}) {
	if (agents.length === 0) return null;
	return (
		<div
			className="slash-palette mention-palette"
			role="listbox"
			aria-label="Agents and threads"
		>
			{agents.map((agent, index) => (
				<div key={agent.id} role="presentation">
					<button
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						data-active={index === activeIndex}
						title={agent.task}
						onMouseEnter={() => onHover(index)}
						// Keep the composer focused, so its caret stays put.
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => onSelect(agent)}
					>
						{agent.threadId ? (
							<span
								className="mention-palette-thread"
								style={
									{
										"--thread-color": threadColor({
											id: agent.threadId,
											threadNumber: agent.threadNumber,
										}),
									} as CSSProperties
								}
							>
								<ThreadMark size={14} />
							</span>
						) : (
							<AgentIcon icon={agent.icon} color={agent.color} size={14} />
						)}
						<span className="mention-palette-name">{agent.name}</span>
						<span className="mention-palette-task">{agent.task ?? ""}</span>
					</button>
				</div>
			))}
		</div>
	);
}
