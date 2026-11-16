import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	ConversationRecovery,
	ConversationRecoverySlot,
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

it("keeps the recovery row's room under a message whose point has not loaded", () => {
	const slot = renderToStaticMarkup(<ConversationRecoverySlot />);
	const row = renderToStaticMarkup(
		<ConversationRecovery
			codeAvailable={false}
			busy={false}
			onRecover={async () => {}}
		/>,
	);
	// Same row element either way, and the row's height does not depend on the icon.
	expect(slot).toMatch(/^<div class="conversation-recovery"/);
	expect(row).toMatch(/^<div class="conversation-recovery"/);
	const css = readFileSync(
		new URL("./session-composer.css", import.meta.url),
		"utf8",
	);
	const rule = css.match(/\n\.conversation-recovery \{[^}]*\}/)?.[0] ?? "";
	expect(rule).toContain("min-height: 26px;");
});

it("offers no menu while forking is off and no code can be restored", () => {
	const html = renderToStaticMarkup(
		<ConversationRecovery
			codeAvailable={false}
			forkAvailable={false}
			busy={false}
			onRecover={async () => {}}
		/>,
	);
	expect(html).toMatch(/^<div class="conversation-recovery"/);
	expect(html).not.toContain("conversation-recovery-trigger");
});

it("names only the restore in the trigger while forking is off", () => {
	const off = renderToStaticMarkup(
		<ConversationRecovery
			codeAvailable
			forkAvailable={false}
			busy={false}
			onRecover={async () => {}}
		/>,
	);
	const on = renderToStaticMarkup(
		<ConversationRecovery
			codeAvailable
			busy={false}
			onRecover={async () => {}}
		/>,
	);
	expect(off).toContain('aria-label="Restore from here"');
	expect(on).toContain('aria-label="Restore or fork from here"');
});
