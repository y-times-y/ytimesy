import {
	PULL_REQUEST_WAKE_LIMITS,
	type PullRequestWakeKind,
} from "#/domain/pull-request-wake";
import { database } from "./database";

export type PullRequestLink = {
	id: string;
	userId: string;
	projectId: string;
	installationId: string;
	repositoryId: string;
	fullName: string;
	pullNumber: number;
	headRef: string;
	baseRef: string;
	originSessionId: string | null;
	sessionId: string | null;
};

type LinkRow = {
	id: string;
	user_id: string;
	project_id: string;
	installation_id: string;
	repository_id: string;
	full_name: string;
	pull_number: number;
	head_ref: string;
	base_ref: string;
	origin_session_id: string | null;
	session_id: string | null;
};

const LINK_COLUMNS =
	"l.id,l.user_id,l.project_id,l.installation_id::text,l.repository_id::text,l.full_name,l.pull_number,l.head_ref,l.base_ref,l.origin_session_id,l.session_id";

function toLink(row: LinkRow): PullRequestLink {
	return {
		id: row.id,
		userId: row.user_id,
		projectId: row.project_id,
		installationId: String(row.installation_id),
		repositoryId: String(row.repository_id),
		fullName: row.full_name,
		pullNumber: row.pull_number,
		headRef: row.head_ref,
		baseRef: row.base_ref,
		originSessionId: row.origin_session_id,
		sessionId: row.session_id,
	};
}

/**
 * Records a pull request ytimesy opened (or found open) for this project's
 * branch. Resolves the link's id: the existing one when it was recorded before.
 */
export async function recordPullRequestLink(input: {
	id: string;
	userId: string;
	projectId: string;
	installationId: number | string;
	repositoryId: number | string;
	fullName: string;
	pullNumber: number;
	headRef: string;
	baseRef: string;
	originSessionId: string | null;
}): Promise<string> {
	const result = await database().query<{ id: string }>(
		`insert into pull_request_link(id,user_id,project_id,installation_id,repository_id,full_name,pull_number,head_ref,base_ref,origin_session_id)
		 select $1,$2,p.id,$4,$5,$6,$7,$8,$9,$10 from project p where p.id=$3 and p.user_id=$2
		 on conflict(project_id,repository_id,pull_number) do update set
		  full_name=excluded.full_name,head_ref=excluded.head_ref,base_ref=excluded.base_ref,
		  installation_id=excluded.installation_id,updated_at=now()
		 returning id`,
		[
			input.id,
			input.userId,
			input.projectId,
			input.installationId,
			input.repositoryId,
			input.fullName,
			input.pullNumber,
			input.headRef,
			input.baseRef,
			input.originSessionId,
		],
	);
	const id = result.rows[0]?.id;
	if (!id) throw new Error("The project is not available.");
	return id;
}

/** The link, only for its owner and while the repository is still in the project. */
export async function pullRequestLinkForOwner(
	userId: string,
	projectId: string,
	linkId: string,
): Promise<PullRequestLink | null> {
	const result = await database().query<LinkRow>(
		`select ${LINK_COLUMNS} from pull_request_link l
		 join project p on p.id=l.project_id and p.user_id=l.user_id
		 join project_repository r on r.project_id=p.id and r.repository_id::bigint=l.repository_id
		 where l.id=$1 and l.user_id=$2 and l.project_id=$3`,
		[linkId, userId, projectId],
	);
	return result.rows[0] ? toLink(result.rows[0]) : null;
}

export async function bindPullRequestLinkSession(
	linkId: string,
	sessionId: string,
) {
	await database().query(
		"update pull_request_link set session_id=$2,updated_at=now() where id=$1",
		[linkId, sessionId],
	);
}

type StagedWake = {
	repositoryId: number;
	installationId: number | null;
	pullNumbers: readonly number[];
	deliveryId: string;
	kind: Exclude<PullRequestWakeKind, "fix">;
	sourceId: number;
	headSha: string | null;
};

/**
 * Stages one wake per linked pull request. A redelivery (same comment, or a
 * failure on the same head) is a no-op; past the per-PR limit nothing is
 * staged. CI waits briefly so the push's other checks can finish first. A
 * task's own pull request is left to PR repair (src/server/services/pr-repair.ts).
 * Resolves how many wakes were staged.
 */
export async function stagePullRequestWakes(wake: StagedWake) {
	if (!wake.pullNumbers.length) return 0;
	const limit =
		wake.kind === "ci"
			? PULL_REQUEST_WAKE_LIMITS.ci
			: PULL_REQUEST_WAKE_LIMITS.comment;
	const dedupe =
		wake.kind === "ci" ? `ci:${wake.headSha}` : `${wake.kind}:${wake.sourceId}`;
	const result = await database().query(
		`insert into pull_request_wake(link_id,dedupe_key,delivery_id,kind,source_id,head_sha,available_at)
		 select l.id,$4,$5,$6,$7,$8,now()+make_interval(secs=>$9::int)
		 from pull_request_link l
		 join project p on p.id=l.project_id and p.user_id=l.user_id
		 join project_repository r on r.project_id=p.id and r.repository_id::bigint=l.repository_id
		 where l.repository_id=$1 and l.pull_number=any($2::int[])
		  and ($3::bigint is null or l.installation_id=$3)
		  and not ($6='ci' and exists(select 1 from agent_session s
		   where s.id=l.origin_session_id and s.parent_session_id is not null))
		  and (select count(*) from pull_request_wake w where w.link_id=l.id
		   and (case when $6='ci' then w.kind='ci' else w.kind<>'ci' end)
		   and w.created_at>now()-make_interval(hours=>$10::int)) < $11::int
		 on conflict(link_id,dedupe_key) do nothing`,
		[
			wake.repositoryId,
			[...wake.pullNumbers],
			wake.installationId,
			dedupe,
			wake.deliveryId,
			wake.kind,
			wake.sourceId,
			wake.headSha,
			wake.kind === "ci" ? 90 : 0,
			limit.windowHours,
			limit.limit,
		],
	);
	return result.rowCount ?? 0;
}

export type ClaimedWake = {
	link: PullRequestLink;
	dedupeKey: string;
	deliveryId: string;
	kind: Exclude<PullRequestWakeKind, "fix">;
	sourceId: number | null;
	headSha: string | null;
	failures: number;
};

/** Takes the oldest due wake; a claim that is not finished is retried after 90 seconds. */
export async function claimPullRequestWake(): Promise<ClaimedWake | null> {
	const result = await database().query<
		LinkRow & {
			dedupe_key: string;
			delivery_id: string;
			kind: ClaimedWake["kind"];
			source_id: string | null;
			head_sha: string | null;
			failures: number;
		}
	>(
		`with next as (
		  select link_id,dedupe_key from pull_request_wake
		  where status in ('pending','dispatching') and available_at<=now()
		  order by created_at for update skip locked limit 1
		 ), claimed as (
		  update pull_request_wake w set status='dispatching',available_at=now()+interval '90 seconds'
		  from next where w.link_id=next.link_id and w.dedupe_key=next.dedupe_key
		  returning w.*
		 )
		 select ${LINK_COLUMNS},c.dedupe_key,c.delivery_id,c.kind,c.source_id::text,c.head_sha,c.failures
		 from claimed c join pull_request_link l on l.id=c.link_id`,
	);
	const row = result.rows[0];
	if (!row) return null;
	return {
		link: toLink(row),
		dedupeKey: row.dedupe_key,
		deliveryId: row.delivery_id,
		kind: row.kind,
		sourceId: row.source_id === null ? null : Number(row.source_id),
		headSha: row.head_sha,
		failures: row.failures,
	};
}

export async function finishPullRequestWake(
	wake: Pick<ClaimedWake, "dedupeKey"> & { link: { id: string } },
	outcome:
		| { status: "delivered"; sessionId: string }
		| { status: "ignored" | "blocked"; reason: string }
		| { status: "retry"; reason: string },
) {
	if (outcome.status === "retry") {
		await database().query(
			`update pull_request_wake set failures=least(failures+1,5),
			  status=case when failures>=4 then 'blocked' else 'pending' end,
			  last_error=$3,available_at=now()+interval '30 seconds'
			 where link_id=$1 and dedupe_key=$2`,
			[wake.link.id, wake.dedupeKey, outcome.reason.slice(0, 500)],
		);
		return;
	}
	await database().query(
		"update pull_request_wake set status=$3,session_id=$4,last_error=$5 where link_id=$1 and dedupe_key=$2",
		[
			wake.link.id,
			wake.dedupeKey,
			outcome.status,
			outcome.status === "delivered" ? outcome.sessionId : null,
			outcome.status === "delivered" ? null : outcome.reason.slice(0, 500),
		],
	);
}
