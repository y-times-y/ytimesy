import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	RecoveryAlert,
	refreshRecoveredWorkspace,
} from "./conversation-recovery";

it("refreshes the Files and Changes views after code is restored", async () => {
	const client = new QueryClient();
	const files = ["workspace-explorer", "project", "session"];
	const changes = ["workspace-changes", "project", "session"];
	const other = ["chats", "project"];
	// A file created after the restored point, still cached by both views.
	client.setQueryData(files, { paths: ["qa-hello.txt"] });
	client.setQueryData(changes, [{ path: "qa-hello.txt" }]);
	client.setQueryData(other, []);
	await refreshRecoveredWorkspace(client);
	expect(client.getQueryState(files)?.isInvalidated).toBe(true);
	expect(client.getQueryState(changes)?.isInvalidated).toBe(true);
	expect(client.getQueryState(other)?.isInvalidated).toBe(false);
});

it("keeps a recovery failure on screen with a way to dismiss it", () => {
	const html = renderToStaticMarkup(
		<RecoveryAlert
			message="Couldn't fork this chat. Try again."
			onDismiss={() => {}}
		/>,
	);
	expect(html).toContain('role="alert"');
	expect(html).toContain("Couldn&#x27;t fork this chat. Try again.");
	expect(html).toContain('aria-label="Dismiss"');
});
