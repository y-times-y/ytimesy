import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
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
