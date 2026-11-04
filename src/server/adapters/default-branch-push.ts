import { database } from "./database";

/**
 * "Allow pushes to main without asking" (project.allow_default_branch_push):
 * workspace git may push to the repository's default branch without the
 * user approving each push. False for a project the user does not own.
 */
export async function projectAllowsDefaultBranchPush(
	userId: string,
	projectId: string,
) {
	return (await defaultBranchPushSetting(userId, projectId)) === true;
}

/** The project's setting; null when the user does not own it. */
export async function defaultBranchPushSetting(
	userId: string,
	projectId: string,
) {
	const row = (
		await database().query<{ allow_default_branch_push: boolean }>(
			"select allow_default_branch_push from project where id=$1 and user_id=$2",
			[projectId, userId],
		)
	).rows[0];
	return row ? row.allow_default_branch_push : null;
}

export async function setDefaultBranchPushSetting(
	userId: string,
	projectId: string,
	allowed: boolean,
) {
	const updated = await database().query(
		"update project set allow_default_branch_push=$3 where id=$1 and user_id=$2 returning id",
		[projectId, userId, allowed],
	);
	if (!updated.rows.length)
		throw new Response("Project is not available.", { status: 404 });
}
