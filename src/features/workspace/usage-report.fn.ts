import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { dayString } from "#/domain/usage-report";
import { readUsageDaily } from "#/server/adapters/usage-rollup";
import { requireUser } from "#/server/auth/auth";

/** The heatmap's span: the last 52 weeks plus the current one. */
const HEATMAP_DAYS = 371;

/**
 * The signed-in user's daily usage, a year back. The user comes from the
 * session only; the function takes no user id.
 */
export const usageReportFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		const today = new Date().toISOString().slice(0, 10);
		const since = dayString(
			Math.floor(Date.parse(`${today}T00:00:00Z`) / 86_400_000) -
				(HEATMAP_DAYS - 1),
		);
		return { today, since, rows: await readUsageDaily(user.id, since) };
	},
);
