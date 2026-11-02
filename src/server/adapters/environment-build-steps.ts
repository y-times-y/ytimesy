import type {
	EnvironmentBuildFailure,
	EnvironmentBuildProgress,
	EnvironmentBuildStepState,
	EnvironmentBuildStepView,
	EnvironmentBuildView,
} from "#/domain/environment-build-progress";
import type { RepositorySetup } from "#/domain/environment-detection";
import { database } from "./database";

/**
 * A build's steps as the live setup view shows them. Recording is best
 * effort: a failed write never fails the build. Replayed stages write the
 * same rows again (keyed by step), keeping when each step first started.
 */
export interface EnvironmentBuildSteps {
	start(key: string, label: string, command?: string | null): Promise<void>;
	output(key: string, output: string): Promise<void>;
	finish(
		key: string,
		state: Exclude<EnvironmentBuildStepState, "running">,
		details?: {
			readonly exitCode?: number | null;
			readonly output?: string | null;
			readonly note?: string | null;
		},
	): Promise<void>;
}

export const noBuildSteps: EnvironmentBuildSteps = {
	start: async () => {},
	output: async () => {},
	finish: async () => {},
};

const bounded = (value: string | null | undefined, limit: number) =>
	value == null ? null : value.slice(-limit);

export function databaseBuildSteps(buildId: string): EnvironmentBuildSteps {
	const write = (sql: string, params: unknown[]) =>
		database()
			.query(sql, params)
			.then(
				() => undefined,
				() => undefined,
			);
	return {
		start: (key, label, command = null) =>
			write(
				`insert into environment_build_step(build_id,key,label,command,state)
				 values($1,$2,$3,$4,'running')
				 on conflict (build_id,key) do update set label=excluded.label,command=excluded.command,
				 state='running',exit_code=null,note=null,completed_at=null`,
				[buildId, key, label.slice(0, 200), bounded(command, 2000)],
			),
		output: (key, output) =>
			write(
				"update environment_build_step set output=$3 where build_id=$1 and key=$2 and state='running'",
				[buildId, key, bounded(output, 4000)],
			),
		finish: (key, state, details = {}) =>
			write(
				`update environment_build_step set state=$3,exit_code=$4,
				 output=coalesce($5,output),note=$6,completed_at=now()
				 where build_id=$1 and key=$2`,
				[
					buildId,
					key,
					state,
					details.exitCode ?? null,
					bounded(details.output, 4000),
					details.note?.slice(0, 300) ?? null,
				],
			),
	};
}

/** Steps a stopped build left running are marked failed with it. */
export async function failRunningBuildSteps(buildId: string) {
	await database()
		.query(
			"update environment_build_step set state='failed',completed_at=now() where build_id=$1 and state='running'",
			[buildId],
		)
		.catch(() => undefined);
}

type BuildRow = {
	id: string;
	status: EnvironmentBuildView["status"];
	created_at: Date | string;
	completed_at: Date | string | null;
	error_message: string | null;
	failure: EnvironmentBuildFailure | null;
	rebuild: boolean;
};

const iso = (value: Date | string) =>
	value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function buildView(row: BuildRow): EnvironmentBuildView {
	return {
		id: row.id,
		status: row.status,
		rebuild: row.rebuild,
		startedAt: iso(row.created_at),
		completedAt: row.completed_at ? iso(row.completed_at) : null,
		errorMessage: row.error_message,
		failure: row.failure ?? null,
	};
}

/**
 * The workspace's newest build. A rebuild is any build after the first ready
 * one: the project keeps that environment while it runs.
 */
export async function latestEnvironmentBuild(
	workspaceId: string,
): Promise<EnvironmentBuildView | null> {
	const result = await database().query<BuildRow>(
		`select b.id,b.status,b.created_at,b.completed_at,b.error_message,b.failure,
		   exists(select 1 from environment_build r where r.workspace_id=b.workspace_id
		     and r.status='ready' and r.id<>b.id and r.created_at<b.created_at) as rebuild
		 from environment_build b where b.workspace_id=$1
		 order by b.created_at desc limit 1`,
		[workspaceId],
	);
	return result.rows[0] ? buildView(result.rows[0]) : null;
}

/** What each repository's setup was in the environment chats use now. */
export async function activeEnvironmentSetup(
	workspaceId: string,
): Promise<RepositorySetup[] | null> {
	const result = await database().query<{ setup: RepositorySetup[] | null }>(
		`select setup from environment_build where workspace_id=$1 and status='ready'
		 order by completed_at desc nulls last limit 1`,
		[workspaceId],
	);
	return result.rows[0]?.setup ?? null;
}

/** The newest build and its steps, for the live view (read while it runs). */
export async function environmentBuildProgress(
	workspaceId: string,
): Promise<EnvironmentBuildProgress> {
	const build = await latestEnvironmentBuild(workspaceId);
	if (!build) return { build: null, steps: [] };
	const result = await database().query<{
		key: string;
		label: string;
		command: string | null;
		state: EnvironmentBuildStepState;
		exit_code: number | null;
		output: string | null;
		note: string | null;
		started_at: Date | string;
		completed_at: Date | string | null;
	}>(
		`select key,label,command,state,exit_code,output,note,started_at,completed_at
		 from environment_build_step where build_id=$1 order by started_at, key limit 40`,
		[build.id],
	);
	const steps: EnvironmentBuildStepView[] = result.rows.map((row) => ({
		key: row.key,
		label: row.label,
		command: row.command,
		state: row.state,
		exitCode: row.exit_code,
		output: row.output,
		note: row.note,
		startedAt: iso(row.started_at),
		completedAt: row.completed_at ? iso(row.completed_at) : null,
	}));
	return { build, steps };
}
