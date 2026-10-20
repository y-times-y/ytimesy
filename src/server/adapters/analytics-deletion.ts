/**
 * Deletes a user's PostHog person with their events and session recordings
 * (the distinct id is the user id, as captureServerAnalytics sends it).
 * Needs a personal API key with person:write and the project id; returns
 * false when they are not configured, so the caller can report a leftover.
 * PostHog processes the deletion asynchronously.
 */
export async function deleteAnalyticsPerson(
	userId: string,
	fetcher: typeof fetch = fetch,
) {
	const key = process.env.POSTHOG_PERSONAL_API_KEY?.trim();
	const project = process.env.POSTHOG_PROJECT_ID?.trim();
	if (!key || !project || !/^\d+$/.test(project)) return false;
	// The private API lives on the app host, not the ingestion host.
	const host = (
		process.env.POSTHOG_API_HOST ||
		(process.env.POSTHOG_HOST || "https://us.i.posthog.com")
			.replace("://us.i.", "://us.")
			.replace("://eu.i.", "://eu.")
	).replace(/\/+$/, "");
	const response = await fetcher(
		`${host}/api/projects/${project}/persons/bulk_delete/`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				distinct_ids: [userId],
				delete_events: true,
				delete_recordings: true,
			}),
			signal: AbortSignal.timeout(10_000),
		},
	);
	await response.body?.cancel().catch(() => {});
	if (!response.ok)
		throw new Error(`Analytics person deletion failed (${response.status}).`);
	return true;
}
