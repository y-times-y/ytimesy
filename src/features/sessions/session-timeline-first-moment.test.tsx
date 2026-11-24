import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SessionItemId } from "#/domain/ids";
import { SessionTimeline } from "./session-timeline";

const sent = {
	kind: "userMessage",
	id: SessionItemId("u1"),
	text: "Fix the build",
} as const;

it("shows the sent message and Starting in the reply's place before any reply", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline items={[sent]} turnStatus="running" />,
	);
	expect(html).toContain("Fix the build");
	// The reply's row comes next, sized as the reply's first line.
	expect(html).toMatch(
		/<li [^>]*data-kind="working" data-follows="userMessage"[^>]*><p class="session-working session-shimmer" role="status">Starting…<\/p><\/li>/,
	);
});

it("replaces Starting with the reply's first words", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			items={[
				sent,
				{
					kind: "agentMessage",
					id: SessionItemId("a1"),
					text: "Looking",
					streaming: true,
				},
			]}
			turnStatus="running"
		/>,
	);
	expect(html).not.toContain('data-kind="working"');
	expect(html).toMatch(
		/data-kind="agentMessage"[^>]*data-follows="userMessage"/,
	);
});

it("keeps Thinking after a completed step instead of restarting the first-activity timer", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline
			items={[
				sent,
				{
					kind: "commandExecution",
					id: SessionItemId("step-9"),
					command: "pwd",
					cwd: null,
					status: "completed",
					output: "/repo",
					exitCode: 0,
				},
			]}
			turnStatus="running"
		/>,
	);
	expect(html).toContain("Thinking");
	expect(html).not.toContain("Starting…");
});

it("does not show progress when the turn is idle", () => {
	const html = renderToStaticMarkup(
		<SessionTimeline items={[sent]} turnStatus="idle" />,
	);
	expect(html).not.toContain("Starting…");
});

it("shows a queued message as stopping until the stopped turn settles", () => {
	const queued = {
		kind: "userMessage",
		id: SessionItemId("u2"),
		text: "Then run the tests",
		queued: true,
	} as const;
	const render = (stopping: boolean) =>
		renderToStaticMarkup(
			<SessionTimeline
				items={[sent, queued]}
				turnStatus="idle"
				stopping={stopping}
			/>,
		);
	expect(render(false)).toContain("Queued in this chat");
	expect(render(true)).toContain("Stopping…");
	expect(render(true)).not.toContain("Queued in this chat");
});
