import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../sessions/agent-session.fn", () => ({
	readThreadAskFn: async () => null,
	answerThreadFn: async () => ({ ok: true, turnStatus: "running" }),
}));
vi.mock("./project-secrets.fn", () => ({
	saveProjectSecretFn: async () => [],
}));

const { INBOX_RETRY_TEXT, inboxAnswerable, YInboxControls } = await import(
	"./y-inbox-controls"
);

const html = (waitingOn: "question" | "secret" | "failed" | "push" | "plan") =>
	renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<YInboxControls
				projectId="p"
				threadId="t"
				title="web-41"
				waitingOn={waitingOn}
				onOpen={() => undefined}
			/>
		</QueryClientProvider>,
	);

describe("YInboxControls", () => {
	it("answers only what an inline control can", () => {
		for (const waits of ["question", "secret", "failed"] as const)
			expect(inboxAnswerable(waits)).toBe(true);
		for (const waits of ["push", "plan", "paused"] as const)
			expect(inboxAnswerable(waits)).toBe(false);
	});

	it("offers Retry for a failed thread, Answer here for a question, Enter it here for a secret", () => {
		expect(html("failed")).toContain(">Retry<");
		expect(html("question")).toContain(">Answer here<");
		expect(html("secret")).toContain(">Enter it here<");
	});

	it("renders nothing for a push or a plan, which need the thread's own card", () => {
		expect(html("push")).toBe("");
		expect(html("plan")).toBe("");
	});

	it("retries by asking the thread to continue where it stopped", () => {
		expect(INBOX_RETRY_TEXT).toContain("Retry it: continue where you stopped");
	});
});
