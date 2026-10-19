import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle } from "freestyle";
import { WorkspaceId } from "../src/domain/ids";
import { sessionItemsFromUnknown } from "../src/domain/session-item";
import { desktopPortIsListening } from "../src/domain/workspace-desktop";
import {
	deleteAgentSessionForOwner,
	insertAgentSession,
	saveAgentSessionProviderRef,
} from "../src/server/adapters/agent-sessions";
import { claimApiTurn } from "../src/server/adapters/api-turns";
import { withBackgroundJobDispatcher } from "../src/server/adapters/background-job-dispatch";
import { closeDatabase, database } from "../src/server/adapters/database";
import { GUEST_INTERNET_FIREWALL } from "../src/server/adapters/freestyle/proof-vm";
import { probeWorkspaceDesktop } from "../src/server/adapters/freestyle/start-desktop";
import { waitUntilVmRunning } from "../src/server/adapters/freestyle/wait-until-running";
import { createFreestyleWorkspaceMachines } from "../src/server/adapters/freestyle/workspace-machines";
import { dispatchModelWorkflow } from "../src/server/adapters/model-workflow-dispatch";
import { cancelServerTurn } from "../src/server/services/cancel-server-turn";
import { sendSubscriptionTask } from "../src/server/services/codex-subscription-session";
import {
	desktopEdgeHostname,
	desktopViewerCredentialDigest,
} from "../src/server/services/vm-edge-keys";
import { DEVELOPMENT_EDGE_ORIGIN } from "./development-config";

// Operator-only proof on development: does the chat agent start the shared
// desktop on its own and use it to check a UI change? One disposable,
// run-capped VM and one root (builder) chat per run; both are deleted after.
if (process.env.VISUAL_QA_PROOF !== "1")
	throw new Error("Enable VISUAL_QA_PROOF=1.");
const ref = "zqkptvyvoyqqtpihlshw";
if (
	(await readFile("supabase/.temp/project-ref", "utf8")).trim() !== ref ||
	!new URL(process.env.DATABASE_URL ?? "").username.includes(ref)
)
	throw new Error("Not the approved development database.");
const origin = DEVELOPMENT_EDGE_ORIGIN;
process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
process.env.YTIMESY_MODEL_WORKFLOW_URL = origin;
process.env.YTIMESY_REALTIME_URL = origin;
process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
	await readFile(".ytimesy/realtime-development.json", "utf8"),
).secret;
const apiKey = process.env.FREESTYLE_API_KEY;
if (!apiKey) throw new Error("Missing Freestyle API key.");
const client = new Freestyle({ apiKey });
const machines = createFreestyleWorkspaceMachines(apiKey);
const db = database();
const run = process.env.VISUAL_QA_RUN ?? "1";
const evidenceDirectory = `.ytimesy/visual-qa-proof/${new Date().toISOString().slice(0, 10)}`;
const task =
	process.env.VISUAL_QA_TASK ??
	"On the landing page, add a blue 'Subscribe' button under the main heading. Verify it renders correctly.";

const record = process.env.VISUAL_QA_RECORD === "1";
const frames = "/var/tmp/ytimesy-recording";
const timeline = new Map<
	string,
	{ tool: string; startedAt: number; endedAt?: number }
>();

/** Pull the frames in chunks and encode them locally as an 8x timelapse. */
async function saveRecording(vm: WorkspaceId, started: number) {
	await machines.exec(vm, "pkill -f ytimesy-recording || true", 10_000);
	const names = (
		await machines.exec(vm, `ls ${frames} 2>/dev/null | sort`, 15_000)
	).stdout
		.split("\n")
		.map((name) => name.trim())
		.filter((name) => /^\d+\.jpg$/.test(name));
	if (!names.length) return undefined;
	const local = `${evidenceDirectory}/run-${run}-frames`;
	await rm(local, { recursive: true, force: true });
	await mkdir(local, { recursive: true });
	for (let index = 0; index < names.length; index += 25) {
		const chunk = names.slice(index, index + 25);
		const result = await machines.exec(
			vm,
			`cd ${frames} && tar cf - ${chunk.join(" ")} | base64 -w0`,
			60_000,
		);
		const archive = `${local}/chunk.tar`;
		await writeFile(archive, Buffer.from(result.stdout.trim(), "base64"));
		execFileSync("tar", ["xf", archive, "-C", local]);
		await rm(archive);
	}
	// Each frame's name is its capture time; firstFrameAt lines it up with the timeline.
	const list = names.map((name) => `file '${name}'\nduration 0.125`).join("\n");
	await writeFile(`${local}/frames.txt`, `${list}\n`);
	const output = `${evidenceDirectory}/run-${run}.mp4`;
	execFileSync(
		"ffmpeg",
		[
			"-y",
			"-loglevel",
			"error",
			"-f",
			"concat",
			"-safe",
			"0",
			"-i",
			`${local}/frames.txt`,
			"-vf",
			"scale=1440:-2,format=yuv420p",
			"-r",
			"8",
			output,
		],
		{ stdio: "inherit" },
	);
	return {
		path: output,
		frames: names.length,
		firstFrameAt: Math.round((Number(names[0].slice(0, -4)) - started) / 1000),
	};
}

let vmId: string | undefined;
let slug: string | undefined;
let session: { userId: string; sessionId: string } | undefined;
try {
	const owners = (
		await db.query<{ user_id: string }>(
			"select user_id from agent_account where provider='codex' and status='connected' and encrypted_codex_auth is not null",
		)
	).rows;
	if (owners.length !== 1)
		throw new Error("Requires one connected subscription owner.");
	const userId = owners[0].user_id;
	const source = (
		await db.query<{
			project_id: string;
			workspace_id: string;
			listed_model_id: string;
		}>(
			"select s.project_id,s.workspace_id,s.listed_model_id from agent_session s where s.user_id=$1 and s.harness='codex' and s.listed_model_id is not null and ($2::uuid is null or s.project_id=$2) order by s.updated_at desc limit 1",
			[userId, process.env.VISUAL_QA_PROJECT_ID ?? null],
		)
	).rows[0];
	if (!source) throw new Error("No subscription model is configured.");
	const busy = await db.query(
		"select 1 from api_turn where state in ('queued','running') limit 1",
	);
	if (busy.rowCount)
		throw new Error("Other active turns exist; isolated admission refused.");

	// Usage admission resolves a VM's owner from its slug: the bound chat's id.
	const chat = await insertAgentSession({
		userId,
		projectId: source.project_id,
		workspaceId: source.workspace_id,
		harness: "codex",
		title: `Visual QA proof ${run}`,
		listedModelId: source.listed_model_id,
	});
	session = { userId, sessionId: chat.id };
	// Like a real chat: a copy of the project's prepared environment.
	const snapshotId = (
		await db.query<{ template_snapshot_id: string | null }>(
			"select template_snapshot_id from workspace where id=$1",
			[source.workspace_id],
		)
	).rows[0]?.template_snapshot_id;
	if (!snapshotId) throw new Error("The project has no prepared environment.");
	slug = `ytimesy-ag-${chat.id.replaceAll("-", "").slice(0, 16)}`;
	const created = await client.vms.create({
		slug,
		snapshotId,
		firewall: GUEST_INTERNET_FIREWALL,
		maxRunTotalSeconds: 2400,
		idleTimeoutSeconds: 300,
		automaticRestart: false,
		metadata: { purpose: "ytimesy-visual-qa-proof" },
	} as never);
	vmId = created.vmId;
	const vm = WorkspaceId(vmId);
	await saveAgentSessionProviderRef(chat.id, vmId);
	await db.query("update agent_session set status='ready' where id=$1", [
		chat.id,
	]);
	await waitUntilVmRunning(created.vm, "Visual QA proof");
	// Optional recording: about one JPEG a second of the shared display, from
	// whenever the agent starts it. The recorder never starts the display.
	if (record)
		await machines.exec(
			vm,
			`mkdir -p ${frames} && nohup sh -c 'while :; do if command -v scrot >/dev/null && pgrep -x Xvfb >/dev/null; then DISPLAY=:0 scrot -q 40 ${frames}/$(date +%s%3N).jpg 2>/dev/null; fi; sleep 1; done' >/dev/null 2>&1 &`,
			15_000,
		);

	const started = Date.now();
	await withBackgroundJobDispatcher(
		async () => {},
		() =>
			sendSubscriptionTask(
				{ userId, projectId: source.project_id, sessionId: chat.id },
				{ modelId: source.listed_model_id, variant: "medium", text: task },
				true,
			),
	);
	const turn = await claimApiTurn(2, 64, "durable-object", chat.id);
	if (turn?.lease_id) await dispatchModelWorkflow(turn);

	let final: { state: string; items: unknown } | undefined;
	// A timed-out turn has no final row; keep the last items seen so its tools are still reported.
	let lastItems: unknown;
	const deadline = Date.now() + 25 * 60_000;
	while (Date.now() < deadline) {
		const state = (
			await db.query<{ state: string; items: unknown }>(
				"select t.state,s.items from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
				[chat.id],
			)
		).rows[0];
		lastItems = state?.items ?? lastItems;
		// Seconds since the task was sent, sampled every few seconds.
		for (const item of sessionItemsFromUnknown(state?.items))
			if (item.kind === "dynamicToolCall") {
				const at = Math.round((Date.now() - started) / 1000);
				const seen = timeline.get(item.id) ?? {
					tool: item.tool,
					startedAt: at,
				};
				if (item.status !== "inProgress") seen.endedAt ??= at;
				timeline.set(item.id, seen);
			}
		if (state && !["queued", "running"].includes(state.state)) {
			final = state;
			break;
		}
		await delay(3000);
	}
	// A settled turn queues its checkpoint; the capture runs on the edge.
	let checkpointSaved = false;
	for (let wait = 0; final && wait < 36 && !checkpointSaved; wait++) {
		checkpointSaved = Boolean(
			(
				await db.query("select 1 from session_checkpoint where session_id=$1", [
					chat.id,
				])
			).rowCount,
		);
		if (!checkpointSaved) await delay(5000);
	}
	const items = sessionItemsFromUnknown(final?.items ?? lastItems);
	const tools = items.flatMap((item) =>
		item.kind === "dynamicToolCall"
			? [
					{
						tool: item.tool,
						status: item.status,
						...timeline.get(item.id),
						...(item.status === "failed"
							? { output: String(item.output ?? "").slice(0, 2000) }
							: {}),
					},
				]
			: [],
	);
	const browserTools = tools.filter((call) => call.tool.startsWith("browser_"));
	const probe = await machines
		.exec(vm, probeWorkspaceDesktop(desktopViewerCredentialDigest(vm)), 15_000)
		.catch(() => null);
	const rules = await client.tls.rules
		.list({ vmId } as never)
		.catch(() => ({ rules: [] as { domain: string }[] }));
	const viewerExposed = (rules as { rules: { domain: string }[] }).rules.some(
		(rule) => rule.domain === desktopEdgeHostname(vmId as string),
	);
	const diff = await machines.exec(
		vm,
		'cd "$(cat /tmp/ytimesy-project-cwd)" && git status --short && git diff --stat HEAD',
		15_000,
	);
	const video = record ? await saveRecording(vm, started) : undefined;
	const report = items
		.filter((item) => item.kind === "agentMessage")
		.map((item) => item.text)
		.join("\n");
	const summary = {
		run,
		state: final?.state ?? "timeout",
		elapsedSeconds: Math.round((Date.now() - started) / 1000),
		toolCalls: tools.length,
		browserTools: browserTools.map((call) => `${call.tool}:${call.status}`),
		startedDesktopUnprompted: browserTools.length > 0,
		screenshots: browserTools.filter(
			(call) =>
				call.tool === "browser_screenshot" && call.status === "completed",
		).length,
		desktopRunningAfter: Boolean(
			probe && desktopPortIsListening(`${probe.stdout}\n${probe.stderr}`),
		),
		viewerExposed,
		reportMentionsVisualCheck: /screenshot|rendered|renders|visual/i.test(
			report,
		),
		changed: diff.stdout.trim().length > 0,
		checkpointSaved,
		firstBrowserToolAt: tools.find((call) => call.tool.startsWith("browser_"))
			?.startedAt,
		lastEditAt: tools.filter((call) => call.tool === "apply_patch").at(-1)
			?.startedAt,
		browserSeconds: browserTools.reduce(
			(total, call) =>
				total + Math.max(0, (call.endedAt ?? 0) - (call.startedAt ?? 0)),
			0,
		),
		video,
	};
	await mkdir(evidenceDirectory, { recursive: true });
	await writeFile(
		`${evidenceDirectory}/run-${run}.json`,
		JSON.stringify(
			{ summary, task, report, diff: diff.stdout, tools },
			null,
			2,
		),
	);
	console.info(JSON.stringify(summary));
} finally {
	if (session)
		await cancelServerTurn(session.userId, session.sessionId).catch(() => {});
	// A create can land and still answer 409 on the SDK's retry.
	if (!vmId && slug)
		vmId = await client.vms
			.list({ limit: 100 } as never)
			.then(
				(page) =>
					(page as { vms?: { id: string; slug?: string }[] }).vms?.find(
						(listed) => listed.slug === slug,
					)?.id,
			)
			.catch(() => undefined);
	if (vmId)
		await client.vms
			.delete(vmId)
			.then(() => console.info("Proof VM deleted."))
			.catch(() => console.error(`Proof VM ${vmId} was not deleted.`));
	if (session)
		await deleteAgentSessionForOwner(session.userId, session.sessionId).catch(
			() => console.error("Proof chat was not deleted."),
		);
	await closeDatabase();
}
