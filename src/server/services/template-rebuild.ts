import {
	preparingWorkspaceText,
	shouldRequestTemplateRebuild,
	TEMPLATE_REBUILD_KIND,
} from "#/domain/template-rebuild";
import { database } from "../adapters/database";
import { environmentBuildProgress } from "../adapters/environment-build-steps";
import { alertOwner } from "../adapters/owner-alerts";
import { postgresJobQueue } from "../jobs/queue";
import { reportInterruption } from "./interruption-monitoring";

type RebuildDeps = {
	readonly now?: () => Date;
	readonly builds?: (workspaceId: string) => Promise<{
		running: boolean;
		lastStartedAt: Date | null;
	}>;
	readonly enqueue?: (workspaceId: string) => Promise<unknown>;
	readonly report?: typeof reportInterruption;
	readonly alert?: typeof alertOwner;
};

async function recentBuilds(workspaceId: string) {
	const { rows } = await database().query<{
		running: boolean;
		last_started_at: Date | null;
	}>(
		`select bool_or(status='running') as running, max(created_at) as last_started_at
		 from environment_build where workspace_id=$1`,
		[workspaceId],
	);
	return {
		running: rows[0]?.running === true,
		lastStartedAt: rows[0]?.last_started_at ?? null,
	};
}

/**
 * The project's template snapshot or its build VM is gone: builds the
 * environment again, once. Deduplicated by the running build (one per
 * workspace, a unique index) and a 5 minute cooldown, so every retry of every
 * waiting chat calls this and only the first enqueues. Never throws:
 * bookkeeping and alerts must not fail the start they describe.
 */
export async function requestTemplateRebuild(
	input: { readonly workspaceId: string; readonly sessionId: string },
	deps: RebuildDeps = {},
): Promise<"requested" | "already-building"> {
	const now = (deps.now ?? (() => new Date()))();
	const builds = await (deps.builds ?? recentBuilds)(input.workspaceId);
	if (
		!shouldRequestTemplateRebuild({
			runningBuild: builds.running,
			lastBuildStartedAt: builds.lastStartedAt,
			now,
		})
	)
		return "already-building";
	await (
		deps.enqueue ??
		((workspaceId) => postgresJobQueue.enqueuePrepare(workspaceId))
	)(input.workspaceId);
	console.warn(
		JSON.stringify({
			event: "template.rebuild_requested",
			workspaceId: input.workspaceId,
			sessionId: input.sessionId,
			cause: "template-missing",
		}),
	);
	await (deps.report ?? reportInterruption)({
		kind: TEMPLATE_REBUILD_KIND,
		sessionId: input.sessionId,
		cause: "snapshot-or-build-vm-not-found",
		recovered: true,
		userVisible: false,
	}).catch(() => undefined);
	await (deps.alert ?? alertOwner)({
		kind: "template-missing",
		key: `${input.workspaceId}:${now.toISOString().slice(0, 10)}`,
		subject:
			"ytimesy: a project's template snapshot was missing; its environment is rebuilding",
		text: `A chat start found workspace ${input.workspaceId}'s template snapshot or build VM missing (404) and requested an automatic environment rebuild (once per workspace per 5 minutes; counted in the digest as ${TEMPLATE_REBUILD_KIND}). Find out what deleted it (the retention sweep, a manual cleanup, a provider expiry).`,
	}).catch(() => undefined);
	return "requested";
}

/** The calm status line for a chat waiting on its project's rebuild: stage and elapsed time. */
export async function preparingWorkspaceStatus(
	sessionId: string,
	now = new Date(),
) {
	try {
		const { rows } = await database().query<{ workspace_id: string }>(
			"select workspace_id from agent_session where id=$1",
			[sessionId],
		);
		const workspaceId = rows[0]?.workspace_id;
		if (!workspaceId) return preparingWorkspaceText({});
		const { build, steps } = await environmentBuildProgress(workspaceId);
		if (build?.status !== "running") return preparingWorkspaceText({});
		const running = [...steps]
			.reverse()
			.find((step) => step.state === "running");
		return preparingWorkspaceText({
			stage: running?.label ?? null,
			elapsedMs: now.getTime() - new Date(build.startedAt).getTime(),
		});
	} catch {
		return preparingWorkspaceText({});
	}
}
