import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	type EnvironmentWorkflowRequest,
	environmentWorkflowRequest,
} from "../../domain/environment-workflow";
import { withCodexSubscriptionEgress } from "../adapters/codex-subscription-transport";
import { withDatabaseScope } from "../adapters/database-scope";
import { environmentFreestyleFetch } from "../adapters/freestyle/environment-fetch";
import { workspaceRuntimeFromEnv } from "../adapters/freestyle/workspace-runtime";
import {
	ResumeLater,
	withResumableCommand,
} from "../adapters/resumable-commands";
import type {
	RuntimeCommandResult,
	WorkspaceRuntime,
} from "../adapters/workspace-runtime";
import {
	activateEnvironmentBuild,
	assertDistinctEnvironmentServicePorts,
	claimEnvironmentBuild,
	failEnvironmentPreflight,
	finishEnvironmentBuild,
	type PreparedRepository,
	prepareEnvironmentRepositories,
	provisionEnvironmentBuild,
	resolveEnvironmentBuildInput,
	verifyEnvironmentRepositories,
} from "../services/environment-build";
import type { EdgeExecutorEnvironment } from "./environment";
import { withEdgeModelEndpoints } from "./model-endpoint";

const configuration = z.object({
	DATABASE_URL: z.string().min(1),
	DATABASE_SSL_CA: z.string().optional(),
	YTIMESY_GIT_PROXY_URL: z.url(),
	YTIMESY_GIT_PROXY_SECRET: z.string().min(32),
});

/** Work stops a little before Cloudflare's 15-minute alarm limit and resumes. */
const ALARM_BUDGET_MS = 13 * 60 * 1000;
const RESUME_DELAY_MS = 5_000;

/**
 * How a stage behaves when a restart interrupted it: "replay" stages re-run, with
 * every VM command replayed from the journal or re-attached if still running;
 * "once" stages have side effects outside the VM and fail closed; "cleanup" is
 * idempotent and retried.
 */
type StagePolicy = "replay" | "once" | "cleanup";

type CommandJournal = {
	stage: string;
	next: number;
};

/**
 * One per project workspace. Runs environment builds as recorded stages in its
 * own SQLite, one alarm at a time, so builds longer than an alarm's 15-minute
 * limit continue across alarms and survive restarts. Requests for the same
 * workspace run in arrival order.
 */
export class ProjectEnvironment extends DurableObject<EdgeExecutorEnvironment> {
	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		ctx.storage.sql.exec(`create table if not exists environment_request(
			request_id text primary key, payload text not null,
			state text not null check(state in ('queued','running','done')), created_at integer not null)`);
		ctx.storage.sql.exec(`create table if not exists environment_stage(
			request_id text not null, name text not null,
			state text not null check(state in ('started','done')), result text,
			primary key(request_id,name))`);
		ctx.storage.sql.exec(`create table if not exists environment_command(
			request_id text not null, stage text not null, key text not null, result text not null,
			primary key(request_id,stage,key))`);
	}

	/** Idempotent by request ID. */
	async start(request: EnvironmentWorkflowRequest) {
		const parsed = environmentWorkflowRequest.parse(request);
		this.ctx.storage.sql.exec(
			"insert into environment_request values(?,?,'queued',?) on conflict(request_id) do nothing",
			parsed.requestId,
			JSON.stringify(parsed),
			Date.now(),
		);
		if ((await this.ctx.storage.getAlarm()) === null)
			await this.ctx.storage.setAlarm(Date.now());
	}

	async alarm() {
		const row = this.ctx.storage.sql
			.exec<{ requestId: string; payload: string }>(
				`select request_id as requestId,payload from environment_request
				 where state in ('running','queued') order by state='running' desc,created_at limit 1`,
			)
			.toArray()[0];
		if (!row) return;
		this.ctx.storage.sql.exec(
			"update environment_request set state='running' where request_id=?",
			row.requestId,
		);
		const request = environmentWorkflowRequest.parse(JSON.parse(row.payload));
		try {
			await this.build(request, Date.now() + ALARM_BUDGET_MS);
		} catch (error) {
			if (error instanceof ResumeLater) {
				await this.ctx.storage.setAlarm(Date.now() + RESUME_DELAY_MS);
				return;
			}
			console.warn("Environment build failed.", {
				requestId: request.requestId,
				// Messages can carry provider or SQL diagnostics; log the class only.
				error: error instanceof Error ? error.name : "unknown",
			});
		}
		this.ctx.storage.sql.exec(
			"update environment_request set state='done' where request_id=?",
			request.requestId,
		);
		// Journals only serve resumption; the request row keeps admission idempotent.
		this.ctx.storage.sql.exec(
			"delete from environment_stage where request_id=?",
			request.requestId,
		);
		this.ctx.storage.sql.exec(
			"delete from environment_command where request_id=?",
			request.requestId,
		);
		this.ctx.storage.sql.exec(
			"delete from environment_request where state='done' and created_at<?",
			Date.now() - 7 * 24 * 60 * 60 * 1000,
		);
		const queued = this.ctx.storage.sql
			.exec("select 1 from environment_request where state='queued' limit 1")
			.toArray().length;
		if (queued) await this.ctx.storage.setAlarm(Date.now());
	}

	private async build(request: EnvironmentWorkflowRequest, deadline: number) {
		configuration.parse(this.env);
		const counts = { requests: 0, backgroundPolls: 0 };
		const journal = { current: null as CommandJournal | null };
		const runtime = this.journaled(
			workspaceRuntimeFromEnv(process.env, {
				fetch: environmentFreestyleFetch(counts),
				streamSetupCommands: true,
			}),
			request.requestId,
			journal,
			deadline,
		);
		const recorded = async <T>(
			name: string,
			policy: StagePolicy,
			run: () => Promise<T>,
		): Promise<T> => {
			const stage = this.ctx.storage.sql
				.exec<{ state: string; result: string | null }>(
					"select state,result from environment_stage where request_id=? and name=?",
					request.requestId,
					name,
				)
				.toArray()[0];
			if (stage?.state === "done") return JSON.parse(stage.result ?? "null");
			if (stage && policy === "once")
				throw new Error(
					`Environment stage ${name} was interrupted; its outcome is unknown.`,
				);
			this.ctx.storage.sql.exec(
				"insert into environment_stage values(?,?,'started',null) on conflict do nothing",
				request.requestId,
				name,
			);
			const attempts = policy === "cleanup" ? 3 : 1;
			for (let attempt = 1; ; attempt++) {
				const before = { ...counts };
				journal.current = { stage: name, next: 0 };
				try {
					const result = await withDatabaseScope(
						this.env.HYPERDRIVE.connectionString,
						() =>
							withCodexSubscriptionEgress(
								(input, options) => this.env.CODEX_EGRESS.fetch(input, options),
								() => withEdgeModelEndpoints(run),
							),
						null,
					);
					this.ctx.storage.sql.exec(
						"update environment_stage set state='done',result=? where request_id=? and name=?",
						JSON.stringify(result ?? null),
						request.requestId,
						name,
					);
					return result;
				} catch (error) {
					if (error instanceof ResumeLater || attempt >= attempts) throw error;
					await new Promise((resolve) =>
						setTimeout(resolve, 5_000 * 2 ** (attempt - 1)),
					);
				} finally {
					journal.current = null;
					console.info("environment-provider-requests", {
						stage: name,
						requests: counts.requests - before.requests,
						backgroundPolls: counts.backgroundPolls - before.backgroundPolls,
					});
				}
			}
		};
		const input = await recorded(
			"resolve-authorized-sources",
			"replay",
			async () => {
				try {
					return await resolveEnvironmentBuildInput(
						request.workspaceId,
						request.force,
						runtime,
						request.repairModel,
					);
				} catch {
					await failEnvironmentPreflight(request.workspaceId);
					throw new Error("Environment source authorization failed.");
				}
			},
		);
		if (!input) return { outcome: "unchanged" };
		const buildId = await recorded("claim-build", "once", () =>
			claimEnvironmentBuild(input, runtime),
		);
		const cleanup = () =>
			recorded("finish-and-pause", "cleanup", () =>
				finishEnvironmentBuild(input, buildId, runtime).then(() => ({
					cleaned: true,
				})),
			);
		let snapshotId: string;
		try {
			// Provisioning is idempotent: the VM is found again by its build slug.
			const vm = await recorded("provision", "replay", () =>
				provisionEnvironmentBuild(input, buildId, runtime),
			);
			const repositories: PreparedRepository[] = [];
			for (const [index, repository] of input.repositories.entries()) {
				const prepared = await recorded(
					`checkout-and-install-${index}`,
					"replay",
					() =>
						prepareEnvironmentRepositories(
							{ ...input, repositories: [repository] },
							vm,
							runtime,
						),
				);
				repositories.push(...prepared);
			}
			assertDistinctEnvironmentServicePorts(repositories);
			const verified = await recorded("verify", "replay", () =>
				verifyEnvironmentRepositories(input, vm, repositories, runtime),
			);
			snapshotId = await recorded("activate-snapshot", "once", () =>
				activateEnvironmentBuild(input, buildId, vm, verified, runtime),
			);
		} catch (error) {
			// Still running on the VM: keep the build VM as it is and continue later.
			if (error instanceof ResumeLater) throw error;
			await cleanup();
			throw error;
		}
		await cleanup();
		return { outcome: "ready", snapshotId };
	}

	/**
	 * Every VM command a stage runs is recorded by its position, so re-running the
	 * stage replays finished commands and re-attaches to one still running.
	 */
	private journaled(
		runtime: WorkspaceRuntime,
		requestId: string,
		journal: { current: CommandJournal | null },
		deadline: number,
	): WorkspaceRuntime {
		const sql = this.ctx.storage.sql;
		const exec: WorkspaceRuntime["exec"] = async (vm, argv, env, timeoutMs) => {
			const current = journal.current;
			if (!current) return runtime.exec(vm, argv, env, timeoutMs);
			const key = `${current.next++}:${createHash("sha256")
				.update(JSON.stringify([vm, argv, timeoutMs]))
				.digest("hex")}`;
			const saved = sql
				.exec<{ result: string }>(
					"select result from environment_command where request_id=? and stage=? and key=?",
					requestId,
					current.stage,
					key,
				)
				.toArray()[0];
			if (saved) return JSON.parse(saved.result) as RuntimeCommandResult;
			const commandId = createHash("sha256")
				.update(`${requestId}:${current.stage}:${key}`)
				.digest("hex")
				.slice(0, 32);
			const result = await withResumableCommand({ commandId, deadline }, () =>
				runtime.exec(vm, argv, env, timeoutMs),
			);
			sql.exec(
				"insert into environment_command values(?,?,?,?) on conflict do nothing",
				requestId,
				current.stage,
				key,
				JSON.stringify(result),
			);
			return result;
		};
		return new Proxy(runtime, {
			get(target, property, receiver) {
				if (property === "exec") return exec;
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	}
}
