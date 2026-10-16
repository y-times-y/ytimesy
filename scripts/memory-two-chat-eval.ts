// Does cross-chat memory (Agent Memory Repo) help? Development only.
//
//   node --import tsx scripts/memory-two-chat-eval.ts --dry-run
//       Offline: every scenario verifier passes a rule-following answer and
//       fails a rule-breaking one, and chat 2 never leaks the rule.
//   CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000 CLOUDFLARE_API_TOKEN=$(npx wrangler auth token) \
//     node --import tsx scripts/memory-two-chat-eval.ts --recall
//       Offline line retrieval with the read hook's embeddings: requests in
//       different words than the saved rule must surface it.
//   node --env-file=.env --import tsx scripts/memory-two-chat-eval.ts --live --arms off,spec,full
//       Live two-chat runs on the development edge with the Codex subscription.
//
// Arms (live):
//   off   chat 2 only, memory off: the baseline.
//   spec  the spec's loop: MEMORY.md at chat start, the builder saves and
//         pushes, then one dream between the chats.
//   full  spec plus the read hook, the save hook and the extra metadata keys.
// Each (arm, scenario) gets a throwaway project and its own memory repo
// (user_memory.repo override), so runs never see each other's memory or the
// owner's real memory. Scenarios run one at a time: memory settings are per user.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import {
	cosineSimilarity,
	MEMORY_MATCH_LIMIT,
	MEMORY_MATCH_MIN_SIMILARITY,
	MEMORY_PART_OPEN,
	memoryLineEmbeddingText,
} from "../src/domain/memory-repo";
import {
	DISTRACTOR_LINES,
	RECALL_PROBES,
	RULE_FILES,
	SCENARIOS,
	type Scenario,
} from "./memory-eval/scenarios";

const run = promisify(execFile);

const { values: flags } = parseArgs({
	options: {
		"dry-run": { type: "boolean", default: false },
		recall: { type: "boolean", default: false },
		live: { type: "boolean", default: false },
		arms: { type: "string", default: "off,spec,full" },
		scenarios: { type: "string" },
		model: { type: "string", default: "gpt-6.1-sol" },
		effort: { type: "string", default: "medium" },
		"turn-timeout": { type: "string", default: "300" },
		"dream-timeout": { type: "string", default: "600" },
		/** USD per million tokens, for the $ columns; omit on a ChatGPT plan. */
		"price-in": { type: "string" },
		"price-out": { type: "string" },
		"keep-repos": { type: "boolean", default: false },
		out: { type: "string" },
	},
});

const PROMPT_SUFFIX =
	"\n\nWork directly in this repository: no plan proposal, child tasks, pull requests or publishing, and no commits to this repository. Stop when the change is done and checked.";

const fixtureRepoScript = (dir: string) =>
	`cd '${dir}' && git init -q && git add -A && git -c user.name=Eval -c user.email=eval@example.invalid commit -qm fixture && git update-ref refs/ytimesy/base HEAD`;

const shellCommand = (script: string) =>
	`bash -c '${script.replaceAll("'", "'\\''")}'`;

function selectScenarios() {
	if (!flags.scenarios) return SCENARIOS;
	return flags.scenarios.split(",").map((id) => {
		const scenario = SCENARIOS.find((row) => row.id === id.trim());
		if (!scenario)
			throw new Error(
				`Unknown scenario ${id}; choose from ${SCENARIOS.map((row) => row.id).join(", ")}.`,
			);
		return scenario;
	});
}

function table(rows: string[][]) {
	const widths = rows[0].map((_, column) =>
		Math.max(...rows.map((row) => row[column].length)),
	);
	return rows
		.map((row) =>
			row.map((cell, column) => cell.padEnd(widths[column])).join("  "),
		)
		.join("\n");
}

// ---------------------------------------------------------------------------
// --dry-run

async function writeFiles(dir: string, files: Record<string, string | null>) {
	for (const [path, content] of Object.entries(files)) {
		const target = join(dir, path);
		if (content === null) {
			await rm(target, { force: true });
			continue;
		}
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

async function verifyLocally(
	scenario: Scenario,
	solution: Record<string, string | null>,
) {
	const dir = await mkdtemp(join(tmpdir(), `memory-eval-${scenario.id}-`));
	try {
		await writeFiles(dir, scenario.chat2.files);
		await run("bash", ["-c", fixtureRepoScript(dir)]);
		await writeFiles(dir, solution);
		try {
			await run("bash", ["-c", shellCommand(scenario.verify)], {
				cwd: dir,
				timeout: 30_000,
			});
			return true;
		} catch {
			return false;
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function dryRun() {
	const rows = [["scenario", "untouched", "follows", "breaks", "no leak"]];
	let ok = true;
	for (const scenario of selectScenarios()) {
		const untouched = await verifyLocally(scenario, {});
		const follows = await verifyLocally(scenario, scenario.solutions.follows);
		const breaks = await verifyLocally(scenario, scenario.solutions.breaks);
		const leaked = [
			scenario.chat2.prompt,
			...Object.values(scenario.chat2.files),
		].some((text) => scenario.leaks.test(text));
		const rulePresent = scenario.leaks.test(scenario.chat1.prompt);
		const good = !untouched && follows && !breaks && !leaked && rulePresent;
		ok &&= good;
		rows.push([
			scenario.id,
			untouched ? "PASSES (bad)" : "fails",
			follows ? "passes" : "FAILS (bad)",
			breaks ? "PASSES (bad)" : "fails",
			leaked ? "LEAKS" : rulePresent ? "ok" : "RULE MISSING IN CHAT 1",
		]);
	}
	console.log(table(rows));
	if (!ok) throw new Error("A scenario or verifier is invalid.");
	console.log("\nDry run passed.");
}

// ---------------------------------------------------------------------------
// --recall

/**
 * The read hook's ranking on real embeddings: every scenario rule plus
 * distractors as memory lines; each probe must put its rule in the top
 * lines above the cutoff.
 */
async function recall() {
	const { memoryEmbedder } = await import(
		"../src/server/adapters/memory-embeddings"
	);
	const embed = memoryEmbedder();
	if (!embed)
		throw new Error(
			"Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (npx wrangler auth token).",
		);
	const lines = [
		...SCENARIOS.map((scenario) => ({
			id: scenario.id,
			path: RULE_FILES[scenario.id],
			text: scenario.rule,
		})),
		...DISTRACTOR_LINES.map((line) => ({ id: "distractor", ...line })),
	];
	const vectors = await embed.documents(lines.map(memoryLineEmbeddingText));
	const rows = [
		["probe", "rule", "similarity", "rank", "recalled", "wrong lines injected"],
	];
	let recalled = 0;
	let wrong = 0;
	const similarities: {
		probe: string;
		line: string;
		right: boolean;
		score: number;
	}[] = [];
	for (const probe of RECALL_PROBES) {
		const query = await embed.query(probe.query);
		similarities.push(
			...lines.map((line, index) => ({
				probe: probe.query,
				line: line.text,
				right: line.id === probe.scenario,
				score: cosineSimilarity(query, vectors[index]),
			})),
		);
		const ranked = lines
			.map((line, index) => ({
				...line,
				score: cosineSimilarity(query, vectors[index]),
			}))
			.sort((a, b) => b.score - a.score);
		const rank = ranked.findIndex((line) => line.id === probe.scenario) + 1;
		const hit = ranked[rank - 1];
		const ok =
			rank > 0 &&
			rank <= MEMORY_MATCH_LIMIT &&
			hit.score >= MEMORY_MATCH_MIN_SIMILARITY;
		if (ok) recalled++;
		// What the hook would also inject: other lines in the top five above the cutoff.
		const noise = ranked
			.slice(0, MEMORY_MATCH_LIMIT)
			.filter(
				(line) =>
					line.id !== probe.scenario &&
					line.score >= MEMORY_MATCH_MIN_SIMILARITY,
			).length;
		wrong += noise;
		rows.push([
			probe.query.slice(0, 60),
			probe.scenario,
			hit.score.toFixed(3),
			String(rank),
			ok ? "yes" : "MISS",
			String(noise),
		]);
	}
	console.log(table(rows));
	console.log(
		`\nRecalled ${recalled}/${RECALL_PROBES.length}; ${wrong} wrong lines injected in total (top ${MEMORY_MATCH_LIMIT}, similarity >= ${MEMORY_MATCH_MIN_SIMILARITY}).`,
	);
	// Threshold data: how right and wrong lines score, and what each cutoff would do.
	const right = similarities.filter((row) => row.right).map((row) => row.score);
	const other = similarities
		.filter((row) => !row.right)
		.map((row) => row.score);
	const stats = (values: number[]) => {
		const sorted = [...values].sort((a, b) => a - b);
		const at = (q: number) =>
			sorted[
				Math.min(sorted.length - 1, Math.floor(q * sorted.length))
			].toFixed(3);
		return `min ${at(0)} p25 ${at(0.25)} median ${at(0.5)} p75 ${at(0.75)} max ${at(1)}`;
	};
	console.log(`Right lines: ${stats(right)}`);
	console.log(`Other lines: ${stats(other)}`);
	const sweep = [["cutoff", "right lines above", "other lines above"]];
	for (const cutoff of [0.25, 0.3, 0.33, 0.35, 0.4, 0.45, 0.5, 0.55])
		sweep.push([
			cutoff.toFixed(2),
			`${right.filter((score) => score >= cutoff).length}/${right.length}`,
			`${other.filter((score) => score >= cutoff).length}/${other.length}`,
		]);
	console.log(`\n${table(sweep)}`);
	if (flags.out) {
		await writeFile(flags.out, JSON.stringify(similarities, null, 2));
		console.log(`Wrote ${flags.out}`);
	}
}

// ---------------------------------------------------------------------------
// --live

type ChatRecord = {
	sessionId: string | null;
	state: string;
	elapsedMs: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedTokens: number | null;
	memoryAttached: boolean;
	errors: string[];
};

type MemoryCost = {
	kind: string;
	calls: number;
	inputTokens: number;
	outputTokens: number;
	cachedTokens: number;
};

type ScenarioRecord = {
	arm: string;
	scenario: string;
	repo: string | null;
	passed: boolean | null;
	verifierOutput: string;
	dream: string;
	chat1: ChatRecord | null;
	chat2: ChatRecord | null;
	memoryCosts: MemoryCost[];
	errors: string[];
};

async function live() {
	const arms = flags.arms.split(",").map((arm) => arm.trim());
	if (!arms.every((arm) => ["off", "spec", "full"].includes(arm)))
		throw new Error("--arms accepts off, spec and full.");
	const model = flags.model;
	const effort = flags.effort;
	if (!/^[a-z0-9._-]+$/.test(model) || !/^[a-z]+$/.test(effort))
		throw new Error("Invalid --model or --effort.");
	const turnTimeoutMs =
		Math.min(900, Math.max(60, Number(flags["turn-timeout"]) || 300)) * 1000;
	const dreamTimeoutMs =
		Math.min(900, Math.max(60, Number(flags["dream-timeout"]) || 600)) * 1000;
	const scenarios = selectScenarios();

	const DEV_REF = "exampledevprojectref";
	const ORIGIN =
		"https://ytimesy-edge-executor-development.example-account.workers.dev";
	const NAMESPACE = "ytimesy-memory-development";
	if (!new URL(process.env.DATABASE_URL ?? "").username.includes(DEV_REF))
		throw new Error(
			"Refusing to run: DATABASE_URL is not the development project.",
		);
	process.env.YTIMESY_MODEL_EXECUTION_TARGET = "durable-object";
	process.env.YTIMESY_INFRASTRUCTURE_ADMISSION = "false";
	process.env.YTIMESY_MODEL_WORKFLOW_URL = ORIGIN;
	process.env.YTIMESY_BACKGROUND_WORKFLOW_URL = ORIGIN;
	process.env.YTIMESY_REALTIME_URL = ORIGIN;
	process.env.YTIMESY_REALTIME_SECRET ||= JSON.parse(
		await readFile(".ytimesy/realtime-development.json", "utf8"),
	).secret;
	const apiKey = process.env.FREESTYLE_API_KEY;
	if (!apiKey) throw new Error("Missing Freestyle API key.");

	// Loaded only here so the offline modes need no database, VM or model settings.
	const { Freestyle } = await import("freestyle");
	const { WorkspaceId } = await import("../src/domain/ids");
	const { sessionItemsFromUnknown } = await import(
		"../src/domain/session-item"
	);
	const { signDeliveryRequest } = await import("../src/domain/delivery-auth");
	const sessions = await import("../src/server/adapters/agent-sessions");
	const { claimApiTurn } = await import("../src/server/adapters/api-turns");
	const { dispatchBackgroundJob, withBackgroundJobDispatcher } = await import(
		"../src/server/adapters/background-job-dispatch"
	);
	const { closeDatabase, database } = await import(
		"../src/server/adapters/database"
	);
	const { workspaceBootSnapshotId } = await import(
		"../src/server/records/tools-snapshot-store"
	);
	const bootSnapshotId = await workspaceBootSnapshotId();
	const { GUEST_INTERNET_FIREWALL } = await import(
		"../src/server/adapters/freestyle/proof-vm"
	);
	const { waitUntilVmRunning } = await import(
		"../src/server/adapters/freestyle/wait-until-running"
	);
	const { createFreestyleWorkspaceMachines } = await import(
		"../src/server/adapters/freestyle/workspace-machines"
	);
	const { dispatchModelWorkflow, modelWorkflowSigningSecret } = await import(
		"../src/server/adapters/model-workflow-dispatch"
	);
	const { cancelServerTurn } = await import(
		"../src/server/services/cancel-server-turn"
	);
	const { sendSubscriptionTask } = await import(
		"../src/server/services/codex-subscription-session"
	);

	const client = new Freestyle({ apiKey });
	const machines = createFreestyleWorkspaceMachines(apiKey);
	const db = database();
	const liveVms = new Set<string>();
	const liveProjects = new Set<string>();
	const liveRepos = new Set<string>();

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
			full_name: string;
		}>(
			"select s.project_id,s.workspace_id,p.full_name from agent_session s join project p on p.id=s.project_id where s.user_id=$1 and s.listed_model_id is not null order by s.updated_at desc limit 1",
			[userId],
		)
	).rows[0];
	if (!source) throw new Error("No project is configured for the owner.");
	const repoName = source.full_name.split("/")[1];
	if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName))
		throw new Error("Invalid fixture directory name.");
	// The owner's own memory settings, restored at the end.
	const savedSettings = (
		await db.query<{
			mode: string;
			repo: string | null;
			dreamed_through: Date | null;
		}>("select mode,repo,dreamed_through from user_memory where user_id=$1", [
			userId,
		])
	).rows[0];

	// Executor gate: a signed probe must reach the dev edge before any VM is made.
	{
		const url = `${ORIGIN}/start`;
		const body = JSON.stringify({
			turnId: randomUUID(),
			leaseId: randomUUID(),
		});
		let open = false;
		for (let attempt = 0; attempt < 30 && !open; attempt++) {
			const response = await fetch(url, {
				method: "POST",
				body,
				headers: await signDeliveryRequest(
					modelWorkflowSigningSecret(),
					"POST",
					url,
					body,
				),
				signal: AbortSignal.timeout(15_000),
			});
			if (response.status === 409) open = true;
			else if (response.status !== 503)
				throw new Error(`Executor preflight failed (${response.status}).`);
			else await delay(2000);
		}
		if (!open) throw new Error("Executor gate is not open.");
	}

	async function setEvalMemory(mode: string, repo: string | null) {
		await db.query(
			`insert into user_memory(user_id,mode,repo,dreamed_through) values($1,$2,$3,now())
			 on conflict(user_id) do update set mode=excluded.mode,repo=excluded.repo,dreamed_through=excluded.dreamed_through,updated_at=now()`,
			[userId, mode, repo],
		);
	}

	async function throwawayProject() {
		const id = randomUUID();
		await db.query(
			`insert into project select (jsonb_populate_record(null::project,
				to_jsonb(p) || jsonb_build_object('id', $2::uuid, 'repository_id', $3::bigint, 'created_at', now()))).*
			 from project p where p.id=$1`,
			[source.project_id, id, 9_000_000_000 + Math.floor(Math.random() * 1e9)],
		);
		liveProjects.add(id);
		const workspaceId = randomUUID();
		await db.query(
			`insert into workspace select (jsonb_populate_record(null::workspace,
				to_jsonb(w) || jsonb_build_object('id', $2::uuid, 'project_id', $3::uuid))).*
			 from workspace w where w.id=$1`,
			[source.workspace_id, workspaceId, id],
		);
		return { projectId: id, workspaceId };
	}

	async function dropProject(id: string) {
		await db.query("delete from project where id=$1 and user_id=$2", [
			id,
			userId,
		]);
		liveProjects.delete(id);
	}

	async function deleteRepo(name: string) {
		await run("npx", [
			"wrangler",
			"artifacts",
			"repos",
			"delete",
			name,
			"--namespace",
			NAMESPACE,
			"-y",
		]).catch(() => {});
		liveRepos.delete(name);
	}

	async function turnState(sessionId: string) {
		return (
			await db.query<{ state: string; items: unknown; messages: unknown }>(
				"select t.state,s.items,t.messages from api_turn t join agent_session s on s.id=t.session_id where t.session_id=$1 order by t.created_at desc limit 1",
				[sessionId],
			)
		).rows[0];
	}

	/** One chat: a new session on a fresh VM with `files`, one prompt, until settled. */
	async function chat(
		{ projectId, workspaceId }: { projectId: string; workspaceId: string },
		title: string,
		files: Record<string, string>,
		prompt: string,
		verify?: string,
	) {
		const record: ChatRecord = {
			sessionId: null,
			state: "not-started",
			elapsedMs: 0,
			inputTokens: null,
			outputTokens: null,
			cachedTokens: null,
			memoryAttached: false,
			errors: [],
		};
		let vmId: string | undefined;
		let verified: { passed: boolean; output: string } | null = null;
		try {
			const session = await sessions.insertAgentSession({
				userId,
				projectId,
				workspaceId,
				harness: "codex",
				title,
				listedModelId: model,
			});
			record.sessionId = session.id;
			const created = await client.vms.create({
				slug: `ytimesy-ag-${session.id.replaceAll("-", "").slice(0, 16)}`,
				snapshotId: bootSnapshotId,
				firewall: GUEST_INTERNET_FIREWALL,
				ttlSeconds: Math.ceil(turnTimeoutMs / 1000) + 600,
				maxRunTotalSeconds: Math.ceil(turnTimeoutMs / 1000) + 300,
				idleTimeoutSeconds: 300,
				automaticRestart: false,
				metadata: { purpose: "ytimesy-memory-eval" },
			});
			vmId = created.vmId;
			liveVms.add(vmId);
			await sessions.saveAgentSessionProviderRef(session.id, vmId);
			await waitUntilVmRunning(created.vm, "Memory eval");
			const workspace = WorkspaceId(vmId);
			const home = (
				await machines.exec(workspace, 'printf %s "$HOME"', 15_000)
			).stdout.trim();
			if (!home.startsWith("/")) throw new Error("VM home is unavailable.");
			const dir = `${home}/${repoName}`;
			const directories = new Set(
				Object.keys(files)
					.filter((path) => path.includes("/"))
					.map((path) => `${dir}/${path.slice(0, path.lastIndexOf("/"))}`),
			);
			await machines.exec(
				workspace,
				`mkdir -p ${[dir, ...directories].map((path) => `'${path}'`).join(" ")}`,
				15_000,
			);
			for (const [path, content] of Object.entries(files))
				await machines.writeTextFile(workspace, `${dir}/${path}`, content);
			const setup = await machines.exec(
				workspace,
				`${fixtureRepoScript(dir)} && printf '%s\\n' '${dir}' > /tmp/ytimesy-project-cwd`,
				20_000,
			);
			if (setup.exitCode) throw new Error("Fixture repository setup failed.");
			await db.query("update agent_session set status='ready' where id=$1", [
				session.id,
			]);
			await withBackgroundJobDispatcher(
				async () => {},
				() =>
					sendSubscriptionTask(
						{ userId, projectId, sessionId: session.id },
						{
							modelId: model,
							text: `${prompt}${PROMPT_SUFFIX}`,
							variant: effort,
						},
					),
			);
			const started = Date.now();
			let admitted = false;
			while (!admitted && Date.now() - started < 120_000) {
				const turn = await claimApiTurn(1, 64, "durable-object", session.id);
				if (turn?.lease_id) {
					await dispatchModelWorkflow(turn);
					admitted = true;
				} else if ((await turnState(session.id))?.state !== "queued")
					admitted = true;
				else await delay(2000);
			}
			if (!admitted)
				throw new Error("Turn was not admitted within two minutes.");
			let cancelled = false;
			for (;;) {
				const state = await turnState(session.id);
				const items = sessionItemsFromUnknown(state?.items);
				record.state = state?.state ?? "missing";
				const usage = items.find(
					(item) => item.kind === "userMessage",
				)?.apiUsage;
				if (usage) {
					record.inputTokens = usage.inputTokens;
					record.outputTokens = usage.outputTokens;
					record.cachedTokens = usage.cacheReadTokens;
				}
				record.memoryAttached = JSON.stringify(state?.messages ?? []).includes(
					MEMORY_PART_OPEN,
				);
				if (state && !["queued", "running"].includes(state.state)) break;
				if (Date.now() > started + turnTimeoutMs && !cancelled) {
					cancelled = true;
					record.errors.push(`Cancelled: exceeded ${turnTimeoutMs / 1000}s.`);
					await cancelServerTurn(userId, session.id);
				}
				if (Date.now() > started + turnTimeoutMs + 60_000) {
					record.state = "unsettled";
					break;
				}
				await delay(2000);
			}
			record.elapsedMs = Date.now() - started;
			if (verify) {
				const result = await machines.exec(
					workspace,
					`cd '${dir}' && ${shellCommand(verify)}`,
					60_000,
				);
				verified = {
					passed: result.exitCode === 0,
					output: `${result.stdout}${result.stderr}`.trim().slice(-400),
				};
			}
		} catch (error) {
			record.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (record.sessionId)
				await cancelServerTurn(userId, record.sessionId).catch(() => {});
			if (vmId) {
				const id = vmId;
				await client.vms
					.delete(id)
					.then(() => liveVms.delete(id))
					.catch(() => {});
			}
		}
		return { record, verified };
	}

	/** Dreams now instead of after the idle delay, and waits for it to finish. */
	async function dreamNow(after: Date) {
		await dispatchBackgroundJob({
			id: randomUUID(),
			kind: "memory",
			action: "dream",
			userId,
		});
		const deadline = Date.now() + dreamTimeoutMs;
		while (Date.now() < deadline) {
			const row = (
				await db.query<{ outcome: string }>(
					"select outcome from memory_model_usage where user_id=$1 and kind='dream' and created_at>$2 order by created_at desc limit 1",
					[userId, after],
				)
			).rows[0];
			if (row) return row.outcome;
			await delay(5000);
		}
		return "timeout";
	}

	async function memoryCosts(since: Date): Promise<MemoryCost[]> {
		return (
			await db.query<{
				kind: string;
				calls: string;
				input: string | null;
				output: string | null;
				cached: string | null;
			}>(
				`select kind,count(*) as calls,sum(input_tokens) as input,sum(output_tokens) as output,sum(cache_read_tokens) as cached
				 from memory_model_usage where user_id=$1 and created_at>$2 group by kind order by kind`,
				[userId, since],
			)
		).rows.map((row) => ({
			kind: row.kind,
			calls: Number(row.calls),
			inputTokens: Number(row.input ?? 0),
			outputTokens: Number(row.output ?? 0),
			cachedTokens: Number(row.cached ?? 0),
		}));
	}

	async function runScenario(
		arm: string,
		scenario: Scenario,
	): Promise<ScenarioRecord> {
		const started = new Date();
		const repo =
			arm === "off"
				? null
				: `memory-eval-${arm}-${scenario.id}-${randomUUID().slice(0, 8)}`;
		const result: ScenarioRecord = {
			arm,
			scenario: scenario.id,
			repo,
			passed: null,
			verifierOutput: "",
			dream: "none",
			chat1: null,
			chat2: null,
			memoryCosts: [],
			errors: [],
		};
		const project = await throwawayProject();
		try {
			await setEvalMemory(arm, repo);
			if (repo) liveRepos.add(repo);
			if (arm !== "off") {
				const first = await chat(
					project,
					`Memory eval ${scenario.id} chat 1`,
					scenario.chat1.files,
					scenario.chat1.prompt,
				);
				result.chat1 = first.record;
				// The save hook (full) is queued when chat 1's turn completes.
				if (arm === "full") await delay(30_000);
				result.dream = await dreamNow(started);
			}
			const second = await chat(
				project,
				`Memory eval ${scenario.id} chat 2`,
				scenario.chat2.files,
				scenario.chat2.prompt,
				scenario.verify,
			);
			result.chat2 = second.record;
			result.passed = second.verified?.passed ?? null;
			result.verifierOutput = second.verified?.output ?? "";
			// Chat 2's own save hook may still be running; let it land in the costs.
			if (arm === "full") await delay(20_000);
			result.memoryCosts = await memoryCosts(started);
		} catch (error) {
			result.errors.push(
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			await dropProject(project.projectId).catch(() => {});
			if (repo && !flags["keep-repos"]) await deleteRepo(repo);
		}
		console.log(
			`[${arm}] ${scenario.id}: ${result.passed === null ? "no verdict" : result.passed ? "PASS" : "fail"} (dream ${result.dream}${result.chat2?.memoryAttached ? ", memory attached to chat 2" : ""})${result.errors.length ? ` errors: ${result.errors.join("; ")}` : ""}`,
		);
		return result;
	}

	let stopping = false;
	const stop = () => {
		stopping = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	const results: ScenarioRecord[] = [];
	const started = Date.now();
	try {
		for (const arm of arms)
			for (const scenario of scenarios) {
				if (stopping) break;
				results.push(await runScenario(arm, scenario));
			}
	} finally {
		for (const id of liveVms) await client.vms.delete(id).catch(() => {});
		for (const id of liveProjects) await dropProject(id).catch(() => {});
		if (!flags["keep-repos"])
			for (const name of liveRepos) await deleteRepo(name);
		if (savedSettings)
			await db.query(
				"update user_memory set mode=$2,repo=$3,dreamed_through=$4,updated_at=now() where user_id=$1",
				[
					userId,
					savedSettings.mode,
					savedSettings.repo,
					savedSettings.dreamed_through,
				],
			);
		else await db.query("delete from user_memory where user_id=$1", [userId]);
		await closeDatabase();
	}

	const priceIn = Number(flags["price-in"]);
	const priceOut = Number(flags["price-out"]);
	const dollars = (input: number, output: number) =>
		Number.isFinite(priceIn) && Number.isFinite(priceOut)
			? `$${((input * priceIn + output * priceOut) / 1e6).toFixed(4)}`
			: "n/a";
	const sum = (values: (number | null | undefined)[]) =>
		values.reduce<number>((total, value) => total + (value ?? 0), 0);
	const rows = [
		[
			"arm",
			"pass",
			"chat2 in tok",
			"chat2 out tok",
			"chat2 cache%",
			"chat2 attached",
			"save in/out tok",
			"save $",
			"dream in/out tok",
			"dream $",
		],
	];
	for (const arm of arms) {
		const runs = results.filter((row) => row.arm === arm);
		const chat2 = runs.map((row) => row.chat2);
		const input = sum(chat2.map((c) => c?.inputTokens));
		const cost = (kind: string) => {
			const rowsOfKind = runs.flatMap((row) =>
				row.memoryCosts.filter((entry) => entry.kind === kind),
			);
			const tokensIn = sum(rowsOfKind.map((entry) => entry.inputTokens));
			const tokensOut = sum(rowsOfKind.map((entry) => entry.outputTokens));
			return [`${tokensIn}/${tokensOut}`, dollars(tokensIn, tokensOut)];
		};
		rows.push([
			arm,
			`${runs.filter((row) => row.passed).length}/${runs.length}`,
			String(input),
			String(sum(chat2.map((c) => c?.outputTokens))),
			input
				? `${Math.round((sum(chat2.map((c) => c?.cachedTokens)) / input) * 100)}%`
				: "-",
			`${chat2.filter((c) => c?.memoryAttached).length}/${runs.length}`,
			...cost("save"),
			...cost("dream"),
		]);
	}
	console.log(`\n${table(rows)}`);
	console.log(
		`\nModel ${model} (${effort}); total ${Math.round((Date.now() - started) / 1000)}s. Chat token columns are chat 2's agent turns; save and dream columns are memory jobs on the user's route.`,
	);
	const out =
		flags.out ??
		`/tmp/memory-two-chat-eval-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`;
	await writeFile(out, JSON.stringify({ flags, results }, null, 2));
	console.log(`Wrote ${out}`);
}

if (flags["dry-run"]) await dryRun();
else if (flags.recall) await recall();
else if (flags.live) await live();
else
	throw new Error(
		"Pass --dry-run (verifiers), --recall (offline line retrieval) or --live (dev two-chat runs).",
	);
