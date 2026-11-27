/**
 * Read-only report on settled threads (Y²'s smart auto-archive, docs/y.md):
 * how many hold a VM, what they cost, and how many the keep-or-archive rules
 * would archive now. Counts only: no titles, no transcript text, no ids, no
 * connection strings are printed.
 *
 *   node --import tsx scripts/y2-settled-report.ts [--database-env PRODUCTION_DATABASE_POOLER_URL]
 *
 * The connection is read-only (`default_transaction_read_only`). Pull request
 * state needs the GitHub App's private key, which is not read here: the report
 * gives a lower bound (every pull request counted as unreadable, so kept) and
 * an upper bound (every pull request counted as merged or closed).
 */
import { Pool } from "pg";
import {
	decideSettledThread,
	HOUR_MS,
	type SettledFacts,
	settledFactsFor,
	settledPolicy,
} from "../src/domain/y-settled-threads";

const argument = process.argv.indexOf("--database-env");
const variable =
	(argument > 0 ? process.argv[argument + 1] : null) ??
	"PRODUCTION_DATABASE_POOLER_URL";
const connectionString =
	process.env[variable] ?? process.env.PRODUCTION_DATABASE_URL;
if (!connectionString) {
	console.error(`Set ${variable} (never printed).`);
	process.exit(2);
}

/** Documented in docs/workspace-retention.md: about $3 a month for a paused 32 GiB machine. */
const MONTHLY_PER_MACHINE_USD = 3;
const DISK_GIB_PER_MACHINE = 32;
const IDLE_HOURS = Number(process.env.YTIMESY_Y2_ARCHIVE_IDLE_HOURS) || 24;

const pool = new Pool({
	connectionString,
	max: 2,
	options: "-c default_transaction_read_only=on -c statement_timeout=60000",
	ssl: { rejectUnauthorized: false },
});

type Row = {
	id: string;
	user_id: string;
	project_id: string;
	waiting_on: string | null;
	updated_at: Date;
	has_vm: boolean;
};

async function main() {
	// Test accounts and canary chats are not real threads.
	const threads = await pool.query<Row>(
		`select s.id::text id, s.user_id, s.project_id::text project_id, s.waiting_on, s.updated_at,
		   (s.provider_ref is not null and s.machine_released_at is null) as has_vm
		 from agent_session s
		 join project p on p.id=s.project_id and p.archived_at is null
		 join auth_user u on u.id=s.user_id and u.is_test_account is not true
		 where s.parent_session_id is null and s.archived_at is null
		   and s.chat_role is distinct from 'canary' and s.chat_role is distinct from 'y2'
		   and s.turn_status <> 'running'
		   and not exists (select 1 from api_turn t where t.session_id=s.id and t.state in ('queued','running'))
		   and s.title <> 'New session'`,
	);
	const active = await pool.query<{ n: string }>(
		`select count(*)::text n from agent_session s
		 join auth_user u on u.id=s.user_id and u.is_test_account is not true
		 where s.parent_session_id is null and s.archived_at is null
		   and s.chat_role is distinct from 'canary' and s.chat_role is distinct from 'y2'
		   and (s.turn_status = 'running' or s.waiting_on is not null)`,
	);
	const { database } = await import("../src/server/adapters/database");
	(globalThis as Record<string, unknown>).ytimesyDatabasePool = pool;
	const { threadExtras } = await import(
		"../src/server/adapters/y-settled-facts"
	);
	void database;

	const byProject = new Map<string, Row[]>();
	for (const row of threads.rows) {
		const key = `${row.user_id}\u0000${row.project_id}`;
		byProject.set(key, [...(byProject.get(key) ?? []), row]);
	}
	const now = Date.now();
	const policy = settledPolicy(IDLE_HOURS);
	const lower: Record<string, number> = {};
	const upper: Record<string, number> = {};
	let withVm = 0;
	let prGated = 0;
	let withPr = 0;
	let archivableLower = 0;
	let archivableUpper = 0;
	let archivableLowerVm = 0;
	let archivableUpperVm = 0;
	let settled = 0;
	for (const [key, rows] of byProject) {
		const [userId, projectId] = key.split("\u0000") as [string, string];
		const extras = new Map(
			(
				await threadExtras(
					userId,
					projectId,
					rows.map((row) => row.id),
				)
			).map((extra) => [extra.id, extra]),
		);
		for (const row of rows) {
			const extra = extras.get(row.id);
			if (!extra) continue;
			settled += 1;
			if (row.has_vm) withVm += 1;
			const make = (prOpen?: boolean | null): SettledFacts =>
				settledFactsFor({
					chat: { waitingOn: row.waiting_on, workingSince: null },
					extra,
					updatedAt: row.updated_at.getTime(),
					now,
					...(prOpen === undefined ? {} : { prOpen }),
				});
			const low = decideSettledThread(make(), policy);
			const high = decideSettledThread(make(false), policy);
			lower[low.code] = (lower[low.code] ?? 0) + 1;
			upper[high.code] = (upper[high.code] ?? 0) + 1;
			if (extra.prUrl) withPr += 1;
			if (low.action === "archive") {
				archivableLower += 1;
				if (row.has_vm) archivableLowerVm += 1;
			}
			if (high.action === "archive") {
				archivableUpper += 1;
				if (row.has_vm) archivableUpperVm += 1;
			}
			if (high.action === "archive" && low.action === "keep") prGated += 1;
		}
	}
	const usd = (machines: number) =>
		Math.round(machines * MONTHLY_PER_MACHINE_USD);
	const report = {
		generatedAt: new Date(now).toISOString(),
		idleHours: IDLE_HOURS,
		activeOrWaitingThreads: Number(active.rows[0]?.n ?? 0),
		settledThreads: settled,
		settledHoldingAVm: withVm,
		settledVmDiskGiB: withVm * DISK_GIB_PER_MACHINE,
		settledVmMonthlyUsd: usd(withVm),
		settledWithPullRequest: withPr,
		wouldArchive: { lowerBound: archivableLower, upperBound: archivableUpper },
		wouldReleaseVms: {
			lowerBound: archivableLowerVm,
			upperBound: archivableUpperVm,
		},
		projectedMonthlySavingsUsd: {
			lowerBound: usd(archivableLowerVm),
			upperBound: usd(archivableUpperVm),
		},
		blockedOnlyByPullRequestState: prGated,
		keptByReasonLowerBound: lower,
		keptByReasonUpperBound: upper,
		note: "Bounds differ only by pull request state (needs the GitHub App's private key). Thread age is in hours; nothing here names a thread.",
		hourMs: HOUR_MS,
	};
	console.log(JSON.stringify(report, null, 2));
}

main()
	.catch((error: { code?: string }) => {
		console.error(`Report failed (${error?.code ?? "error"}).`);
		process.exitCode = 1;
	})
	.finally(() => pool.end());
