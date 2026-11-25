import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { claudeSubscriptionEnabled } from "#/domain/claude-code-route";
import {
	addClaudeAccount,
	listSubscriptionAccounts,
	pinSessionAccount,
	removeSubscriptionAccount,
	renameSubscriptionAccount,
	reorderSubscriptionAccounts,
} from "#/server/adapters/subscription-accounts";
import { requireUser } from "#/server/auth/auth";
import { startCodexDeviceLogin } from "#/server/auth/codex-device-login";
import { hasManagedCodexAuth } from "#/server/auth/codex-managed-auth";
import { requireSameOrigin } from "#/server/http";
import { readableServerError } from "#/server/public-error";

const provider = z.enum(["codex", "claude"]);
const accountId = z.union([z.literal("primary"), z.string().uuid()]);
const label = z.string().min(1).max(60);

/** Every mutation: same origin, signed in, and the caller's own accounts only. */
async function owner() {
	const request = getRequest();
	requireSameOrigin(request);
	return (await requireUser(request.headers)).id;
}

/** The user's accounts for Settings and the picker: never a token, email masked. */
export const getSubscriptionAccounts = createServerFn({
	method: "GET",
}).handler(async () => {
	const user = await requireUser(getRequest().headers);
	return listSubscriptionAccounts(user.id);
});

/** Adds another Claude plan from a `claude setup-token` token. */
export const addClaudeAccountFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ token: z.string().min(1).max(1000), label })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const userId = await owner();
		if (!claudeSubscriptionEnabled())
			throw new Error("Claude Agent is not available.");
		try {
			await addClaudeAccount(userId, data);
		} catch (cause) {
			throw await readableServerError(cause);
		}
		return listSubscriptionAccounts(userId);
	});

/**
 * Starts ChatGPT sign-in for another account (the existing device-code flow;
 * the composer's poll finishes it). With no main login yet it is the first.
 */
export const startAddChatgptAccountFn = createServerFn({ method: "POST" })
	.validator((data: unknown) => z.object({ label }).strict().parse(data))
	.handler(async ({ data }) => {
		const userId = await owner();
		return startCodexDeviceLogin(
			userId,
			(await hasManagedCodexAuth(userId)) ? { addAs: data.label } : {},
		);
	});

export const renameSubscriptionAccountFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ provider, accountId, label }).strict().parse(data),
	)
	.handler(async ({ data }) => {
		const userId = await owner();
		try {
			await renameSubscriptionAccount(
				userId,
				data.provider,
				data.accountId,
				data.label,
			);
		} catch (cause) {
			throw await readableServerError(cause);
		}
		return listSubscriptionAccounts(userId);
	});

export const removeSubscriptionAccountFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ provider, accountId }).strict().parse(data),
	)
	.handler(async ({ data }) => {
		const userId = await owner();
		await removeSubscriptionAccount(userId, data.provider, data.accountId);
		return listSubscriptionAccounts(userId);
	});

export const reorderSubscriptionAccountsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ provider, order: z.array(accountId).min(1).max(10) })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const userId = await owner();
		await reorderSubscriptionAccounts(userId, data.provider, data.order);
		return listSubscriptionAccounts(userId);
	});

/** Pins a chat to one account, or `null` for Auto. */
export const pinChatAccountFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ sessionId: z.string().uuid(), accountId: accountId.nullable() })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const userId = await owner();
		try {
			await pinSessionAccount(userId, data.sessionId, data.accountId);
		} catch (cause) {
			throw await readableServerError(cause);
		}
		return { accountId: data.accountId };
	});
