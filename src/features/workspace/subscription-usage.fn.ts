import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import { readClaudePlanUsage } from "#/server/adapters/claude-subscription";
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
 * as Claude Code turns run; null while Claude is off, disconnected or unused.
 */
export const claudePlanUsageFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await requireUser(getRequest().headers);
	if (!claudeSubscriptionEnabled()) return null;
	try {
		return await readClaudePlanUsage(user.id);
	} catch {
		return null;
	}
});
