// Offline end-to-end rehearsal of hard-set runs (docs/hard-set.md,
// "Rehearsal"): the real setup on a local Docker "VM", the real turn path
// (sendSubscriptionTask, admission, executeModelStep/runApiTurn, tools,
// review loop, subagents, sidekick sync, teardown) against a local Postgres
// with every migration, and a scripted model in place of the provider.
//
//   pnpm rehearsal                         # every scenario
//   pnpm rehearsal --scenario fusion       # one or more (comma-separated ids in scenarios.ts)
//   pnpm rehearsal --fresh-setup           # rerun the task setup instead of reusing it
//   pnpm rehearsal --keep                  # leave the VMs running for inspection
//
// Exit code 0 only when every check of every selected scenario passed.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { freshDatabase } from "./db";
import { applyRehearsalEnvironment } from "./env";

const { values } = parseArgs({
	options: {
		scenario: { type: "string", default: "all" },
		"fresh-setup": { type: "boolean", default: false },
		keep: { type: "boolean", default: false },
		task: { type: "string", default: "mvcc-lsm-compaction" },
		timeout: { type: "string", default: "900" },
	},
});
const root = resolve(import.meta.dirname, "../..");
const started = Date.now();
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
const databaseUrl = await freshDatabase(root);
applyRehearsalEnvironment(databaseUrl);

// Server modules read the environment above; load them after it is set.
const { RehearsalVms, removeRehearsalVms } = await import("./vm");
// VMs left by an interrupted rehearsal (labelled; the task snapshot is kept).
await removeRehearsalVms();
const { taskSnapshot } = await import("./task-vm");
const { FakeCodex } = await import("./fake-codex");
const { RehearsalEdge } = await import("./edge");
const { classifierScript, scenarios } = await import("./scenarios");
const { checkScenario, collect } = await import("./checks");
const { seedOwner, createRehearsalUser, startTaskChat, sendFollowUp } =
	await import("./seed");
const { harnessVariantFromFlags } = await import(
	"../../src/domain/harness-variant"
);
const { taskMessage } = await import("../hard-set/environment");
const { closeDatabase } = await import("../../src/server/adapters/database");

const selected = scenarios().filter(
	(scenario) =>
		values.scenario === "all" ||
		values.scenario.split(",").includes(scenario.id),
);
if (!selected.length) throw new Error(`Unknown scenario ${values.scenario}.`);

const vms = new RehearsalVms("rh");
console.log(`rehearsal: database ready (${elapsed()})`);
const prepared = await taskSnapshot(vms, values.task, {
	fresh: values["fresh-setup"],
});
console.log(
	`rehearsal: task VM ${prepared.reused ? "reused" : "set up"} (${elapsed()})\n${prepared.setupLog}`,
);

// The sidekick classifier's requests are told apart first (src/domain/sidekick-classifier.ts).
const fake = new FakeCodex([
	classifierScript(),
	...selected.flatMap((scenario) => scenario.scripts),
]);
const machines = vms.machines();
const edge = new RehearsalEdge({ databaseUrl, machines, egress: fake.fetch });
const owner = await edge.invoke(() => seedOwner());
edge.startCron();

const outDir = join(
	root,
	".ytimesy/rehearsal",
	new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(outDir, { recursive: true });
let failed = 0;
const results = await Promise.all(
	selected.map(async (scenario) => {
		const vm = await vms.startFrom(prepared.snapshot, `rh-${scenario.id}`);
		const variant = harnessVariantFromFlags([scenario.variant]);
		const user = await edge.invoke(() =>
			createRehearsalUser(owner, `rehearsal ${scenario.id}`, variant),
		);
		const text = `${taskMessage(prepared.task, "/app", variant.subagents === "on")}\n\n[rehearsal:${scenario.id}]`;
		const sessionId = await edge.invoke(() =>
			startTaskChat({
				user,
				vm,
				text,
				agentSeconds: 1800,
				title: `Rehearsal ${scenario.id}`,
			}),
		);
		console.log(`rehearsal: ${scenario.id} started (${elapsed()})`);
		let settleError: string | undefined;
		// Waits until the chat's tree is idle with `turns` finished root turns.
		const settle = async (turns: number) => {
			await edge.until(
				async () => {
					const { database } = await import(
						"../../src/server/adapters/database"
					);
					const tree = (
						await database().query<{ id: string }>(
							`with recursive tree as (select id from agent_session where id=$1
							 union all select s.id from agent_session s join tree t on s.parent_session_id=t.id)
							 select id from tree`,
							[sessionId],
						)
					).rows.map((row) => row.id);
					const live = await database().query(
						"select count(*)::int as n from api_turn where session_id = any($1::uuid[]) and state in ('queued','running')",
						[tree],
					);
					// A turn's end work (sidekick retirement, reports) runs after its row is final.
					if (tree.some((id) => edge.isActive(id))) return false;
					const root = await database().query(
						"select count(*)::int as n from api_turn where session_id=$1 and state in ('completed','failed','cancelled')",
						[sessionId],
					);
					return live.rows[0].n === 0 && root.rows[0].n >= turns;
				},
				Number(values.timeout) * 1000,
				`${scenario.id} to settle`,
			);
		};
		try {
			await settle(1);
			// Later user messages in the same chat, each after the last settled.
			for (const [index, followUp] of (scenario.followUps ?? []).entries()) {
				await edge.invoke(() =>
					sendFollowUp({ user, sessionId, text: followUp }),
				);
				console.log(
					`rehearsal: ${scenario.id} follow-up ${index + 1} sent (${elapsed()})`,
				);
				await settle(index + 2);
			}
		} catch (error) {
			settleError = (error as Error).message;
		}
		// Collecting retries: a loaded Docker host can time out one connection.
		let data: Awaited<ReturnType<typeof collect>> | undefined;
		let checks: { name: string; ok: boolean; detail?: string }[] = [];
		for (let attempt = 0; attempt < 3 && !data; attempt++) {
			try {
				data = await edge.invoke(() =>
					collect({ sessionId, userId: user.userId, vm, vms, fake, edge }),
				);
				const collected = data;
				checks = [
					{ name: "turns settled", ok: !settleError, detail: settleError },
					...(await edge.invoke(() =>
						checkScenario(scenario.id, {
							...collected,
							vms,
							vm,
							task: prepared.task,
						}),
					)),
				];
			} catch (error) {
				data = undefined;
				checks = [
					{
						name: "collect the scenario's results",
						ok: false,
						detail: String((error as Error).message),
					},
				];
			}
		}
		await writeFile(
			join(outDir, `${scenario.id}.json`),
			JSON.stringify({ scenario: scenario.id, checks, data }, null, 2),
		);
		return { scenario, checks };
	}),
);

await edge.stop();
results.push({
	scenario: { id: "builder", title: "rehearsal harness" } as never,
	checks: [
		{
			name: "every model conversation matched a script",
			ok: !fake.unmatched.length,
			detail: fake.unmatched[0]?.slice(0, 300),
		},
		{
			name: "no unexpected edge errors",
			ok: !edge.errors.length,
			detail: edge.errors[0]?.split("\n").slice(0, 3).join(" | "),
		},
	],
});
for (const { scenario, checks } of results) {
	console.log(`\n${scenario.title}`);
	for (const check of checks) {
		if (!check.ok) failed++;
		console.log(
			`  ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `: ${check.detail}` : ""}`,
		);
	}
}
console.log(
	`\nrehearsal: ${failed ? `${failed} check(s) FAILED` : "all checks passed"} in ${elapsed()}; details in ${outDir}`,
);
if (!values.keep) await vms.destroyAll();
await closeDatabase();
process.exit(failed ? 1 : 0);
