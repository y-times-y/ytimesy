import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import pg from "pg";
import { unstable_dev } from "wrangler";
import { signDeliveryRequest } from "../src/domain/delivery-auth";
import { SessionItemId } from "../src/domain/ids";
import type { SessionItem } from "../src/domain/session-item";
import {
	claimApiTurn,
	finishApiTurn,
	publishApiTurnProgress,
} from "../src/server/adapters/api-turns";
import {
	claimConversationDeliveries,
	settleConversationDelivery,
} from "../src/server/adapters/conversation-delivery";
import { withDatabaseScope } from "../src/server/adapters/database-scope";
import { turnProgressWriter } from "../src/server/services/turn-progress-writer";

// This experiment accepts only an explicitly supplied disposable localhost database.
const url = process.env.CAPACITY_DATABASE_URL;
if (
	!url ||
	new URL(url).hostname !== "127.0.0.1" ||
	new URL(url).pathname !== "/ytimesy_capacity_fixture"
)
	throw new Error("Provide the dedicated local capacity database URL.");
const secret = "local-capacity-experiment-secret".repeat(2);
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
const percentile = (values: number[], p: number) =>
	values.length
		? [...values].sort((a, b) => a - b)[
				Math.min(values.length - 1, Math.floor(values.length * p))
			]
		: null;
const fixture = new pg.Pool({ connectionString: url, max: 2 });
const persistence = await mkdtemp(join(tmpdir(), "ytimesy-capacity-"));
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
let activeTimer: ReturnType<typeof setInterval> | undefined;
const rows: unknown[] = [];
try {
	await fixture.query(`create role anon; create role authenticated;
	create table auth_user(id text primary key);
	create table model_connection(id uuid primary key);
	create table agent_session(id uuid primary key,user_id text not null,project_id uuid,
	harness text constraint agent_session_harness_check check(harness in ('codex')),
	items jsonb not null default '[]',turn_status text not null default 'idle',task_state text,parent_session_id uuid,updated_at timestamptz not null default now());
	create index agent_session_owner on agent_session(user_id,project_id,updated_at desc);`);
	const turns = await readFile(
		"supabase/migrations/20260927203000_api_turns.sql",
		"utf8",
	);
	await fixture.query(turns.split("create table api_usage_budget")[0]);
	const delivery = await readFile(
		"supabase/migrations/20261001120000_conversation_delivery.sql",
		"utf8",
	);
	await fixture.query(delivery.split("-- Shared-harness")[0]);
	await fixture.query(
		await readFile(
			"supabase/migrations/20261026100000_agent_session_item.sql",
			"utf8",
		),
	);
	for (const file of [
		"20261105100000_agent_session_items_rev",
		"20261114120000_conversation_delivery_items_rev",
	])
		await fixture.query(
			await readFile(`supabase/migrations/${file}.sql`, "utf8"),
		);
	worker = await unstable_dev("src/realtime/worker.ts", {
		config: "wrangler.realtime.jsonc",
		local: true,
		vars: { DELIVERY_SECRET: secret },
		persist: true,
		persistTo: persistence,
		logLevel: "error",
		experimental: { disableExperimentalWarning: true },
	});
	const currentWorker = worker;
	async function request(path: string, body?: string, signal?: AbortSignal) {
		const full = `http://localhost${path}`;
		const method = body === undefined ? "GET" : "POST";
		return currentWorker.fetch(full, {
			method,
			body,
			signal,
			headers: await signDeliveryRequest(secret, method, full, body ?? ""),
		});
	}
	for (const [historyBytes, concurrency] of [
		[128000, 4],
		[128000, 10],
		[128000, 25],
		[128000, 50],
		[512000, 10],
		[512000, 25],
		[512000, 50],
	]) {
		const steps = historyBytes >= 512000 && concurrency >= 25 ? 60 : 12;
		await fixture.query("truncate api_turn,agent_session,auth_user cascade");
		const sessions = Array.from({ length: concurrency }, (_, i) => ({
			id: randomUUID(),
			owner: `fixture-${i}`,
			final: 0,
			completed: false,
		}));
		for (const s of sessions) {
			await fixture.query("insert into auth_user values($1)", [s.owner]);
			await fixture.query(
				"insert into agent_session(id,user_id,harness) values($1,$2,'api')",
				[s.id, s.owner],
			);
			await fixture.query(
				"insert into api_turn(id,session_id,user_id,model_id,connection_revision,state) values($1,$2,$3,'stub','fixture','queued')",
				[randomUUID(), s.id, s.owner],
			);
		}
		const history = randomBytes(Math.ceil(historyBytes * 0.75))
			.toString("base64")
			.slice(0, historyBytes);
		const lag: number[] = [];
		const saveLatency: number[] = [];
		const relayLatency: number[] = [];
		let errors = 0,
			writes = 0,
			relayed = 0,
			relayBytes = 0,
			peakBacklog = 0,
			relayBusy = false;
		const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
		const consumers: Promise<void>[] = [];
		const abort = new AbortController();
		let timer: ReturnType<typeof setInterval> | undefined;
		const cpuStart = process.cpuUsage();
		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		eventLoop.enable();
		const walStart = (await fixture.query("select pg_current_wal_lsn() as lsn"))
			.rows[0].lsn;
		const started = performance.now();
		await withDatabaseScope(url, async () => {
			const admitted = [];
			for (let i = 0; i < concurrency; i++) {
				const turn = await claimApiTurn(1, concurrency);
				if (!turn) throw new Error("Synthetic admission unexpectedly failed.");
				admitted.push(turn);
			}
			const relay = async () => {
				if (relayBusy) return;
				relayBusy = true;
				try {
					const pending = Number(
						(
							await fixture.query(
								"select count(*) from conversation_delivery where revision>delivered_revision",
							)
						).rows[0].count,
					);
					peakBacklog = Math.max(peakBacklog, pending);
					const batch = await claimConversationDeliveries(16);
					await Promise.all(
						batch.map(async (d) => {
							const begin = performance.now();
							const body = JSON.stringify(d.update);
							let ok = false;
							try {
								const response = await request(
									"progress" in d.update ? "/snapshot" : "/delta",
									body,
									AbortSignal.timeout(5000),
								);
								ok = response.status === 204;
								if (!ok) errors++;
							} catch {
								errors++;
							}
							await settleConversationDelivery(d, ok);
							relayed++;
							relayBytes += Buffer.byteLength(body);
							relayLatency.push(performance.now() - begin);
						}),
					);
				} finally {
					relayBusy = false;
				}
			};
			while (
				Number(
					(
						await fixture.query(
							"select count(*) from conversation_delivery where revision>delivered_revision",
						)
					).rows[0].count,
				)
			)
				await relay();
			for (const s of sessions) {
				const response = await request(
					`/stream?userId=${s.owner}&sessionId=${s.id}`,
					undefined,
					abort.signal,
				);
				if (response.status !== 200 || !response.body)
					throw new Error("Synthetic subscription failed.");
				const reader = response.body.getReader();
				readers.push(reader);
				consumers.push(
					(async () => {
						let buffered = "";
						const decoder = new TextDecoder();
						try {
							while (true) {
								const next = await reader.read();
								if (next.done) break;
								buffered += decoder.decode(next.value, { stream: true });
								while (buffered.includes("\n\n")) {
									const end = buffered.indexOf("\n\n");
									const frame = buffered.slice(0, end);
									buffered = buffered.slice(end + 2);
									const data = frame
										.split("\n")
										.find((x) => x.startsWith("data: "));
									if (!data) continue;
									const payload = JSON.parse(data.slice(6));
									const text = payload.items.find(
										(x: { id: string }) => x.id === "progress",
									)?.text;
									const match = /emit:([\d.]+):(\d+)/.exec(text ?? "");
									if (match) {
										if (Number(match[2]) > s.final)
											lag.push(performance.now() - Number(match[1]));
										s.final = Number(match[2]);
									}
									if (payload.turnStatus === "completed") s.completed = true;
								}
							}
						} catch {
							if (!abort.signal.aborted) errors++;
						}
					})(),
				);
			}
			timer = setInterval(() => void relay().catch(() => errors++), 250);
			activeTimer = timer;
			await Promise.all(
				admitted.map(async (turn) => {
					const writer = turnProgressWriter(
						async (items) => {
							const begin = performance.now();
							await publishApiTurnProgress(turn, items);
							writes++;
							saveLatency.push(performance.now() - begin);
						},
						() => errors++,
					);
					let finalItems: SessionItem[] = [];
					for (let seq = 1; seq <= steps; seq++) {
						const items: SessionItem[] = [
							{
								kind: "agentMessage",
								id: SessionItemId("history"),
								text: history,
							},
							{
								kind: "agentMessage",
								id: SessionItemId("progress"),
								text: `emit:${performance.now()}:${seq}`,
							},
						];
						writer.offer(items);
						finalItems = items;
						await sleep(500);
					}
					await writer.drain();
					if (!(await finishApiTurn(turn, "completed", finalItems))) errors++;
				}),
			);
			const deadline = performance.now() + 5000;
			while (
				sessions.some((s) => s.final !== steps || !s.completed) &&
				performance.now() < deadline
			) {
				await relay();
				await sleep(100);
			}
			if (timer) clearInterval(timer);
			while (relayBusy) await sleep(20);
			await Promise.all(readers.map((r) => r.cancel().catch(() => {})));
			abort.abort();
			await Promise.all(consumers);
		});
		const elapsedMs = performance.now() - started;
		eventLoop.disable();
		const cpu = process.cpuUsage(cpuStart);
		const walBytes = Number(
			(
				await fixture.query(
					"select pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text as bytes",
					[walStart],
				)
			).rows[0].bytes,
		);
		const result = {
			historyBytes,
			concurrency,
			offeredUpdates: concurrency * steps,
			writes,
			relayed,
			errors,
			finalFrames: sessions.filter((s) => s.final === steps).length,
			completedFrames: sessions.filter((s) => s.completed).length,
			elapsedMs: Math.round(elapsedMs),
			saveP95Ms: percentile(saveLatency, 0.95),
			deliveryP50Ms: percentile(lag, 0.5),
			deliveryP95Ms: percentile(lag, 0.95),
			deliveryP99Ms: percentile(lag, 0.99),
			relayP95Ms: percentile(relayLatency, 0.95),
			peakBacklog,
			relayBytes,
			walBytes,
			nodeCpuMs: (cpu.user + cpu.system) / 1000,
			nodeRssBytes: process.memoryUsage().rss,
			eventLoopP95Ms: eventLoop.percentile(95) / 1e6,
		};
		rows.push(result);
		console.log(JSON.stringify(result));
	}
	await mkdir(".ytimesy", { recursive: true });
	await writeFile(
		".ytimesy/backend-capacity-2026-10-07.json",
		JSON.stringify(
			{
				scope:
					"local synthetic SQL + workerd progress pipeline, 2-connection application pool; no models, VMs or WAN; no production capacity claim",
				postgresCpuLimit: 2,
				postgresVersion: (await fixture.query("show server_version")).rows[0]
					.server_version,
				postgresMemoryLimitBytes: 1073741824,
				history: "high entropy base64",
				rows,
			},
			null,
			2,
		),
	);
} finally {
	if (activeTimer) clearInterval(activeTimer);
	await worker?.stop();
	await fixture.end();
	await rm(persistence, { recursive: true, force: true });
}
