import { Freestyle } from "freestyle";
import pg from "pg";
import WebSocket from "ws";
import { WorkspaceId } from "#/domain/ids";
import { machineSize } from "#/domain/machine-size";
import { desktopRemoteOrigin } from "#/domain/workspace-desktop";
import { agentSessionForOwner } from "#/server/adapters/agent-sessions";
import { closeDatabase, database } from "#/server/adapters/database";
import { forgetRunningGuest } from "#/server/adapters/freestyle/recent-guest-state";
import { prepareTemplateSnapshot } from "#/server/adapters/freestyle/template-snapshot";
import { createFreestyleWorkspaceMachines } from "#/server/adapters/freestyle/workspace-machines";
import { projectMachineSize } from "#/server/adapters/project-machine-size";
import {
	bindAgentSessionMachine,
	deleteAgentSessionMachine,
	openAgentSession,
} from "#/server/services/agent-session-machine";
import { deferredApiTurnWorkspace } from "#/server/services/api-turn-workspace";
import {
	desktopEdgeHostname,
	desktopViewerAuthorization,
} from "#/server/services/vm-edge-keys";
import {
	readWorkspaceDesktop,
	resolveDesktopRemote,
	resumeSessionMachine,
	startWorkspaceDesktop,
	withdrawDesktopViewer,
} from "#/server/services/workspace-desktop";

// The user-visible waits, measured in-process the way the web server and the
// turn run them (database, usage admission and provider calls included), on
// the dev account and dev database, for an approved admin's ready project:
//   (a) a new chat's machine ready        (b) a follow-up on an idle chat
//   (c) the desktop panel to the VNC banner: new chat, running chat, idle chat
//   (d) the first tool call: turn start to the first command's output
//
//   node --env-file=../cloud-launch/.env --import tsx scripts/measure-chat-waits.ts --run --project <id> [--runs 2]
//
// Each run opens two chats and deletes them (and their machines) at the end.
// Not measured: the browser, the web Worker's own hops and the model.

if (!process.argv.includes("--run"))
	throw new Error(
		"Explicit --run required (creates and deletes dev chats and VMs).",
	);
const arg = (name: string) => {
	const at = process.argv.indexOf(name);
	return at > 0 ? process.argv[at + 1] : undefined;
};
const runs = Number(arg("--runs") ?? 2);
const projectId = arg("--project");
const userId = process.env.YTIMESY_ADMIN_USER_IDS?.split(",")[0];
const key = process.env.FREESTYLE_API_KEY ?? "";
if (!projectId || !userId || !key)
	throw new Error(
		"--project, an admin user and FREESTYLE_API_KEY are required.",
	);
if ((process.env.DATABASE_URL ?? "").includes("exampleprojectref"))
	throw new Error("Refusing the production database.");

type Call = { at: number; ms: number; label: string };
let calls: Call[] = [];
let phaseStart = Date.now();
let dbCount = 0;
let dbMs = 0;
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = new URL(input instanceof Request ? input.url : String(input));
	const started = Date.now();
	try {
		return await realFetch(input, init);
	} finally {
		if (url.hostname.includes("freestyle")) {
			let detail = "";
			try {
				const body = JSON.parse(String(init?.body ?? "{}"));
				detail = String(body.command ?? body.path ?? "")
					.split("\n")[0]
					.slice(0, 40);
			} catch {}
			const path = url.pathname.replace(/\/v5\/vms\/[^/]+/, "/vms/:id");
			calls.push({
				at: started - phaseStart,
				ms: Date.now() - started,
				label: `${init?.method ?? "GET"} ${path} ${detail}`.trim(),
			});
		} else if (!url.hostname.includes("posthog")) {
			calls.push({
				at: started - phaseStart,
				ms: Date.now() - started,
				label: `fetch ${init?.method ?? "GET"} ${url.hostname}${url.pathname.slice(0, 60)}`,
			});
		}
	}
}) as typeof fetch;
const realQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function (this: pg.Pool, ...args: unknown[]) {
	const started = Date.now();
	const result = (realQuery as (...a: unknown[]) => Promise<unknown>).apply(
		this,
		args,
	);
	if (result && typeof (result as Promise<unknown>).finally === "function")
		(result as Promise<unknown>)
			.finally(() => {
				dbCount++;
				dbMs += Date.now() - started;
				const sql =
					typeof args[0] === "string"
						? args[0]
						: String((args[0] as { text?: string })?.text ?? "");
				calls.push({
					at: started - phaseStart,
					ms: Date.now() - started,
					label: `db ${sql.replace(/\s+/g, " ").slice(0, 70)}`,
				});
			})
			.catch(() => undefined);
	return result;
} as typeof realQuery;

const machines = createFreestyleWorkspaceMachines(key);
const client = new Freestyle({ apiKey: key });
const results: Record<string, number[]> = {};

async function phase<T>(name: string, run: () => Promise<T>) {
	calls = [];
	dbCount = 0;
	dbMs = 0;
	phaseStart = Date.now();
	const value = await run();
	const ms = Date.now() - phaseStart;
	results[name] = [...(results[name] ?? []), ms];
	const providerMs = calls
		.filter((c) => !c.label.startsWith("db "))
		.reduce((sum, call) => sum + call.ms, 0);
	console.info(
		`\n${name}: ${ms} ms  (db: ${dbCount} queries, ${dbMs} ms summed; provider: ${calls.length} calls, ${providerMs} ms summed)`,
	);
	for (const call of [...calls].sort((x, y) => x.at - y.at))
		console.info(
			`  +${String(call.at).padStart(5)} ${String(call.ms).padStart(5)} ms  ${call.label}`,
		);
	return value;
}

async function viewerBanner(vmId: string, deadlineMs = 60_000) {
	const origin = desktopRemoteOrigin(desktopEdgeHostname(vmId)).replace(
		/^http/,
		"ws",
	);
	const end = Date.now() + deadlineMs;
	for (let attempt = 1; ; attempt++) {
		const ok = await new Promise<boolean>((resolve) => {
			const socket = new WebSocket(origin, ["binary"], {
				headers: { authorization: desktopViewerAuthorization(vmId) },
			});
			const timer = setTimeout(() => {
				socket.terminate();
				resolve(false);
			}, 10_000);
			socket.on("message", (data) => {
				clearTimeout(timer);
				socket.close();
				resolve(String(data).startsWith("RFB"));
			});
			socket.on("error", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
		if (ok) {
			if (attempt > 1) console.info(`  viewer answered on attempt ${attempt}`);
			return;
		}
		if (Date.now() > end) throw new Error("viewer never answered");
		await new Promise((r) => setTimeout(r, 250));
	}
}

async function pauseAndSettle(vmId: string) {
	const vm = client.vms.ref(vmId);
	await vm.pause();
	for (;;) {
		if ((await vm.data()).state === "paused") return;
		await new Promise((r) => setTimeout(r, 500));
	}
}

async function firstToolCall(sessionId: string, pinNewChatBase: boolean) {
	const owner = await agentSessionForOwner(userId as string, sessionId);
	if (!owner) throw new Error("chat missing");
	const workspace = await deferredApiTurnWorkspace(
		machines,
		owner,
		new AbortController().signal,
		undefined,
		{ pinNewChatBase },
	)();
	const out = await workspace.machines.exec(
		workspace.vm,
		`cd ${workspace.cwd} && git status --short | head -5`,
		30_000,
	);
	if (out.exitCode !== 0)
		throw new Error(`first command failed: ${out.stderr.slice(-200)}`);
	return workspace.vm;
}

const opened: string[] = [];
// --reseal-template: measure against a template prepared as the environment
// build now prepares one (disk at the project's size, desktop running). The
// project's own template is restored at the end and this one deleted.
let restoreTemplate:
	| { id: string; previous: string; resealed: string }
	| undefined;
if (process.argv.includes("--reseal-template")) {
	const row = (
		await database().query<{
			id: string;
			provider_ref: string;
			template_snapshot_id: string;
		}>(
			"select id, provider_ref, template_snapshot_id from workspace where project_id=$1 and user_id=$2",
			[projectId, userId],
		)
	).rows[0];
	if (!row?.provider_ref || !row.template_snapshot_id)
		throw new Error("project has no template");
	await machines.ensureRunning(WorkspaceId(row.provider_ref));
	const prepared = await prepareTemplateSnapshot(
		client.vms.ref(row.provider_ref),
		{
			storageMiB: machineSize(await projectMachineSize(userId, projectId))
				.storage,
			desktop: true,
		},
	);
	if (prepared.skipped.length)
		throw new Error(`template preparation skipped ${prepared.skipped}`);
	const resealed = await machines.snapshotEnvironment(
		WorkspaceId(row.provider_ref),
		`fsf-reseal-${Date.now().toString(36)}`,
	);
	await client.vms
		.ref(row.provider_ref)
		.pause()
		.catch(() => undefined);
	restoreTemplate = {
		id: row.id,
		previous: row.template_snapshot_id,
		resealed,
	};
	await database().query(
		"update workspace set template_snapshot_id=$2 where id=$1",
		[row.id, resealed],
	);
	console.info("measuring against a resealed template");
}
const scopeOf = (sessionId: string) => ({
	userId: userId as string,
	projectId: projectId as string,
	sessionId,
});
try {
	for (let run = 1; run <= runs; run++) {
		console.info(`\n=== run ${run} ===`);
		const tag = `${Date.now().toString(36)}-${run}`;
		const chat = await openAgentSession({
			userId,
			projectId,
			harness: "codex",
			title: `wait probe ${tag}`,
		});
		opened.push(chat.id);
		const fresh = await openAgentSession({
			userId,
			projectId,
			harness: "codex",
			title: `wait probe new ${tag}`,
		});
		opened.push(fresh.id);

		const vm = await phase(
			"(a) new chat machine ready",
			async () =>
				(
					await bindAgentSessionMachine(machines, {
						userId,
						projectId,
						sessionId: chat.id,
						harness: "codex",
					})
				).providerRef,
		);
		forgetRunningGuest(WorkspaceId(vm));
		await phase("(d) first tool call, machine ready", () =>
			firstToolCall(chat.id, false),
		);
		await phase("(d) first tool call, brand-new chat", () =>
			firstToolCall(fresh.id, true),
		);

		await phase("(c) desktop, new chat", async () => {
			const read = await Effect_run(
				readWorkspaceDesktop(machines, scopeOf(chat.id)),
			);
			if (read.status !== "running") {
				const started = await Effect_run(
					startWorkspaceDesktop(machines, scopeOf(chat.id)),
				);
				if (started.status !== "running")
					throw new Error(`desktop: ${JSON.stringify(started)}`);
			}
			await resolveDesktopRemote(scopeOf(chat.id), machines);
			await viewerBanner(vm);
		});
		forgetRunningGuest(WorkspaceId(vm));
		await phase("(c) desktop, running chat", async () => {
			const read = await Effect_run(
				readWorkspaceDesktop(machines, scopeOf(chat.id)),
			);
			if (read.status !== "running") throw new Error("desktop not running");
			await resolveDesktopRemote(scopeOf(chat.id), machines);
			await viewerBanner(vm);
		});

		await pauseAndSettle(vm);
		forgetRunningGuest(WorkspaceId(vm));
		await phase("(b) idle chat follow-up to first command", () =>
			firstToolCall(chat.id, false),
		);

		await pauseAndSettle(vm);
		forgetRunningGuest(WorkspaceId(vm));
		// As after a server restart or on another isolate: no cached desktop,
		// the route withdrawn while the machine slept.
		await withdrawDesktopViewer(machines, vm);
		await phase("(c) desktop, idle chat", async () => {
			const started = await Effect_run(
				startWorkspaceDesktop(machines, scopeOf(chat.id)),
			);
			if (started.status !== "running")
				throw new Error(`desktop: ${JSON.stringify(started)}`);
			await resolveDesktopRemote(scopeOf(chat.id), machines);
			await viewerBanner(vm);
		});

		if (process.argv.includes("--early-wake")) {
			await pauseAndSettle(vm);
			forgetRunningGuest(WorkspaceId(vm));
			// The composer's focus wakes the machine; the message follows ~1.5 s later.
			const woke = Effect_run(resumeSessionMachine(machines, scopeOf(chat.id)));
			await new Promise((r) => setTimeout(r, 1_500));
			await woke;
			await phase("(b) idle chat follow-up after composer wake", () =>
				firstToolCall(chat.id, false),
			);
		}
	}
} finally {
	if (restoreTemplate) {
		await database().query(
			"update workspace set template_snapshot_id=$2 where id=$1",
			[restoreTemplate.id, restoreTemplate.previous],
		);
		await client.vms.snapshots
			.delete(restoreTemplate.resealed)
			.catch(() => undefined);
	}
	for (const sessionId of opened)
		await deleteAgentSessionMachine(machines, {
			userId,
			projectId,
			sessionId,
		}).catch((e) =>
			console.warn("chat cleanup failed", sessionId, String(e).slice(0, 200)),
		);
	console.info("\nsummary (ms):");
	for (const [name, values] of Object.entries(results))
		console.info(`  ${name.padEnd(44)} ${values.join(", ")}`);
	await closeDatabase();
}

async function Effect_run<A>(
	effect: import("effect").Effect.Effect<A, unknown>,
) {
	const { Effect } = await import("effect");
	return Effect.runPromise(effect);
}
