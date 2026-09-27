import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { PublicCodexSession } from "#/server/services/codex-workspace-session";
import { sessionReconciliationQuery } from "./session-reconciliation";

const selection = {
	projectId: "project",
	sessionId: "session",
	harnessId: "codex" as const,
};
it("deduplicates concurrent reads for the same chat and epoch", async () => {
	const client = new QueryClient();
	const read = vi.fn(
		async () => ({ agentSessionId: "session" }) as PublicCodexSession,
	);
	const options = sessionReconciliationQuery(selection, 1, read);
	const [first, second] = await Promise.all([
		client.fetchQuery(options),
		client.fetchQuery(options),
	]);
	expect(read).toHaveBeenCalledTimes(1);
	expect(first).toEqual(second);
	expect(first.epoch).toBe(1);
	client.clear();
});
it("keeps sessions, providers, projects and turn epochs in distinct cache entries", () => {
	const base = sessionReconciliationQuery(selection, 1).queryKey;
	for (const next of [
		{ ...selection, sessionId: "other" },
		{ ...selection, projectId: "other" },
		{ ...selection, harnessId: "claude" as const },
	]) {
		expect(sessionReconciliationQuery(next, 1).queryKey).not.toEqual(base);
	}
	expect(sessionReconciliationQuery(selection, 2).queryKey).not.toEqual(base);
});
it("discards the response from a cancelled read", async () => {
	const client = new QueryClient();
	let complete!: (value: PublicCodexSession) => void;
	const read = () =>
		new Promise<PublicCodexSession>((resolve) => {
			complete = resolve;
		});
	const options = sessionReconciliationQuery(selection, 1, read);
	const pending = client.fetchQuery(options);
	const rejected = expect(pending).rejects.toThrow();
	await client.cancelQueries({ queryKey: options.queryKey });
	complete({ agentSessionId: "session" } as PublicCodexSession);
	await rejected;
	expect(client.getQueryData(options.queryKey)).toBeUndefined();
	client.clear();
});
