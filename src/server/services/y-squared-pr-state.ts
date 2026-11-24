import { database } from "../adapters/database";
import { pullRequestWakeGitHub } from "../adapters/github/pull-request-wake-github";

/** `https://github.com/owner/repo/pull/12` as its repository and number; null for anything else. */
export function pullRequestFromUrl(url: string) {
	const match =
		/^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
			url.trim(),
		);
	return match?.[1] && match[2]
		? { fullName: match[1], number: Number(match[2]) }
		: null;
}

/**
 * Whether a thread's pull request is still open, for archive_thread: true
 * open, false merged or closed, null when it cannot be told (a link ytimesy
 * did not record, GitHub unreachable). One database read and one GitHub read,
 * only when Y² archives a thread that has a pull request.
 */
export async function pullRequestIsOpen(input: {
	readonly userId: string;
	readonly projectId: string;
	readonly url: string;
}): Promise<boolean | null> {
	const pull = pullRequestFromUrl(input.url);
	if (!pull) return null;
	try {
		const result = await database().query<{ installation_id: string }>(
			`select installation_id::text from pull_request_link
			 where user_id=$1 and project_id=$2 and lower(full_name)=lower($3) and pull_number=$4`,
			[input.userId, input.projectId, pull.fullName, pull.number],
		);
		const installationId = result.rows[0]?.installation_id;
		if (!installationId) return null;
		const state = await (
			await pullRequestWakeGitHub({
				installationId,
				fullName: pull.fullName,
				pullNumber: pull.number,
			})
		).pull();
		return state.open;
	} catch {
		return null;
	}
}
