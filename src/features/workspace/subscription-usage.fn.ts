import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import { claudePlanUsageForPicker } from "#/server/adapters/claude-subscription";
import { readCodexSubscriptionUsage } from "#/server/adapters/codex-subscription";
import { requireUser } from "#/server/auth/auth";

export const codexSubscriptionUsageFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await requireUser(getRequest().headers);
	try {
		return (await readCodexSubscriptionUsage(user.id)) ?? null;
	} catch {
		// Never send transport errors or credential-bearing provider payloads to clients.
		return null;
	}
});

/**
 * The Claude plan's latest reading, taken from Anthropic's response headers
 * as Claude Code turns run, or read afresh when it is missing or over five
 * minutes old; null while Claude is off, disconnected or unreadable.
 */
export const claudePlanUsageFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await requireUser(getRequest().headers);
	if (!claudeSubscriptionEnabled()) return null;
	try {
		return await claudePlanUsageForPicker(user.id);
	} catch {
		return null;
	}
});
