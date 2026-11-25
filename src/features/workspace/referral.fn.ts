import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { referralLink } from "#/domain/referral";
import {
	referralCounts,
	referralSummary,
	setReferralEnabled,
} from "#/server/adapters/referral";
import { readSession, requireUser } from "#/server/auth/auth";
import { requireInfrastructureAdmin } from "#/server/auth/infrastructure-admin";
import { serverConfig } from "#/server/config";

async function requireAdmin() {
	const session = await readSession(getRequest().headers);
	if (!session)
		throw new Response("Sign in to manage referral.", { status: 401 });
	requireInfrastructureAdmin(session.user.id);
}

/** The account's referral code, link and counts. Where referral is off: `enabled` false. */
export const referralFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		const user = await requireUser(request.headers);
		const summary = await referralSummary(user.id);
		return {
			...summary,
			link: referralLink(new URL(serverConfig().APP_URL).origin, summary.code),
		};
	},
);

export const referralCountsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		await requireAdmin();
		return referralCounts();
	},
);

export const setReferralEnabledFn = createServerFn({ method: "POST" })
	.validator(z.object({ enabled: z.boolean() }))
	.handler(async ({ data }) => {
		await requireAdmin();
		await setReferralEnabled(data.enabled);
		return referralCounts();
	});
