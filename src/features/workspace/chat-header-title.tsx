import { chatHeaderTitle } from "#/domain/session-item";
import { SUPER_AGENT_NAME } from "#/domain/y-squared";
import { CaptainAvatar } from "../captains/captain-avatar";
import { YSquaredMark } from "./y-squared-mark";

/**
 * The chat header's name: a thread's own title, or for the project's Super
 * agent chat its mark and its name. The stored title ("Y²") is never shown.
 */
export function ChatHeaderTitle({
	superAgent,
	listedTitle,
	sessionTitle,
	captain,
	leaderName,
}: {
	superAgent: boolean;
	listedTitle: string | undefined;
	sessionTitle: string;
	/** The open chat is this captain's (src/domain/captain.ts): its avatar and name. */
	captain?: { name: string; color: string };
	/** What the project's Super agent is called when it is the open chat. */
	leaderName?: string | null;
}) {
	if (captain)
		return (
			<span className="session-title" data-role="captain">
				<CaptainAvatar name={captain.name} color={captain.color} size={20} />
				{captain.name}
			</span>
		);
	return (
		<span className="session-title" data-role={superAgent ? "y2" : undefined}>
			{superAgent ? <YSquaredMark size={20} /> : null}
			{superAgent
				? leaderName || SUPER_AGENT_NAME
				: chatHeaderTitle(listedTitle, sessionTitle)}
		</span>
	);
}
