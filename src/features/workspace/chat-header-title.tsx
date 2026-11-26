import { chatHeaderTitle } from "#/domain/session-item";
import { SUPER_AGENT_NAME } from "#/domain/y-squared";
import { YSquaredMark } from "./y-squared-mark";

/**
 * The chat header's name: a thread's own title, or for the project's Super
 * agent chat its mark and its name. The stored title ("Y²") is never shown.
 */
export function ChatHeaderTitle({
	superAgent,
	listedTitle,
	sessionTitle,
}: {
	superAgent: boolean;
	listedTitle: string | undefined;
	sessionTitle: string;
}) {
	return (
		<span className="session-title" data-role={superAgent ? "y2" : undefined}>
			{superAgent ? <YSquaredMark size={20} /> : null}
			{superAgent
				? SUPER_AGENT_NAME
				: chatHeaderTitle(listedTitle, sessionTitle)}
		</span>
	);
}
