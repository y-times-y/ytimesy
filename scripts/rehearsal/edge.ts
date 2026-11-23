// The development edge, in process: what src/server/edge/executor.ts and
// background-jobs.ts do around the shared server code, with Cloudflare's
// pieces replaced by plain objects.
//
// - Background jobs (dispatchBackgroundJob) run here: "model-admission"
//   claims queued turns (claimApiTurn, executor durable-object) and starts
//   them in their chat's loop; every other job goes to the same
//   deliverBackgroundJob the edge's job runner calls.
// - A chat's loop (ModelConversation) runs a turn's steps one at a time
//   through executeModelStep with in-memory step receipts and the real
//   claimConversationStep rules; the claim reads the turn row as the DO does.
// - The room (turn coordination) is an in-memory lease per chat; progress
//   snapshots are accepted and dropped.
// - The cron's periodic jobs (admission, reconcile, supervise, delivery,
//   task events) run every few seconds instead of every minute.
// - The Codex egress is the scripted model (fake-codex.ts).
// - User sends run as the web Worker runs them (web()): no job dispatcher
//   of their own, and the executor service binding reaches this edge's
//   /turn/start and /jobs/start routes, signed as on the deployed edge.
import { randomUUID } from "node:crypto";
import {
	type BackgroundJob,
	backgroundJob,
} from "../../src/domain/background-job";
import {
	type ConversationStepStorage,
	claimConversationStep,
	type StepReceipt,
} from "../../src/domain/conversation-step-receipts";
import type {
	TurnControl,
	TurnControlAction,
} from "../../src/domain/conversation-turn-control";
import { verifyDeliveryRequest } from "../../src/domain/delivery-auth";
import type {
	WorkflowStep,
	WorkflowStepOutcome,
} from "../../src/domain/model-workflow";
import { modelConcurrencyLimits } from "../../src/server/adapters/agent-capacity";
import {
	type ApiTurn,
	claimApiTurn,
} from "../../src/server/adapters/api-turns";
import {
	backgroundJobId,
	withBackgroundJobDispatcher,
} from "../../src/server/adapters/background-job-dispatch";
import { withCodexSubscriptionEgress } from "../../src/server/adapters/codex-subscription-transport";
import { withConversationTurnCoordinator } from "../../src/server/adapters/conversation-turn-control";
import { database } from "../../src/server/adapters/database";
import { withDatabaseScope } from "../../src/server/adapters/database-scope";
import { withExecutorBinding } from "../../src/server/adapters/executor-fetch";
import { withConversationPublisher } from "../../src/server/adapters/realtime-delivery";
import { turnStartRequest } from "../../src/server/adapters/turn-start";
import { executorIngressRoute } from "../../src/server/edge/ingress-route";
import {
	executeModelStep,
	type WorkflowStepClaim,
} from "../../src/server/jobs/model-workflow-executor";
import { deliverBackgroundJob } from "../../src/server/services/background-job-delivery";
import type { WorkspaceMachines } from "../../src/server/services/workspace-machines";

class MemorySteps implements ConversationStepStorage {
	private rows = new Map<string, StepReceipt & { index: number }>();
	private key(step: WorkflowStep) {
		return `${step.turnId}:${step.leaseId}:${step.index}`;
	}
	read(step: WorkflowStep) {
		return this.rows.get(this.key(step));
	}
	firstStartedAt(step: WorkflowStep) {
		let first: number | undefined;
		for (const [key, row] of this.rows)
			if (key.startsWith(`${step.turnId}:${step.leaseId}:`))
				if (first === undefined || row.index < 1 || row.startedAt < first)
					first = row.startedAt;
		return first;
	}
	insert(step: WorkflowStep, startedAt: number) {
		this.rows.set(this.key(step), {
			state: "processing",
			outcome: null,
			startedAt,
			index: step.index,
		});
	}
	finish(step: WorkflowStep, outcome: WorkflowStepOutcome) {
		const row = this.rows.get(this.key(step));
		if (row?.state !== "processing") return false;
		row.state = "done";
		row.outcome = outcome;
		return true;
	}
}

export type EdgeEvent = { at: number; kind: string; detail: string };

/** One step budget, as the edge's alarm (14 minutes). */
const STEP_BUDGET_MS = 14 * 60 * 1000;
/**
 * The budget a step's command waits are measured against. Shorter than the
 * edge's, so a long command outlives its step within a minute and the next
 * step finds it running (the path a long build takes live).
 */
const WAIT_BUDGET_MS = 120_000;

export class RehearsalEdge {
	readonly events: EdgeEvent[] = [];
	readonly errors: string[] = [];
	private readonly rooms = new Map<string, TurnControl>();
	private readonly chats = new Map<string, Promise<void>>();
	private readonly waiting = new Map<string, ApiTurn[]>();
	private readonly steps = new MemorySteps();
	private readonly pending = new Set<Promise<unknown>>();
	private cron: ReturnType<typeof setInterval> | undefined;
	private cronBusy = false;
	private stopped = false;

	constructor(
		private readonly input: {
			databaseUrl: string;
			machines: WorkspaceMachines;
			egress: typeof fetch;
		},
	) {}

	private note(kind: string, detail: string) {
		this.events.push({ at: Date.now(), kind, detail });
		if (process.env.REHEARSAL_VERBOSE)
			console.log(`  [edge] ${kind} ${detail}`);
	}

	/** Runs `work` the way an edge invocation runs: its own pool and bindings. */
	invoke<T>(work: () => Promise<T>): Promise<T> {
		return withDatabaseScope(
			this.input.databaseUrl,
			() =>
				withConversationTurnCoordinator(
					async (action, turn) => this.coordinate(action, turn),
					() =>
						withConversationPublisher(
							async () => true,
							() =>
								withCodexSubscriptionEgress(this.input.egress, () =>
									withBackgroundJobDispatcher(
										async (job) => this.dispatch(job),
										work,
									),
								),
						),
				),
			null,
		);
	}

	/**
	 * Runs `work` the way the web Worker runs a request: its own pool, the
	 * executor service binding (this edge's routes) and no job dispatcher.
	 */
	web<T>(work: () => Promise<T>): Promise<T> {
		return withDatabaseScope(
			this.input.databaseUrl,
			() =>
				withCodexSubscriptionEgress(this.input.egress, () =>
					withExecutorBinding((url, init) => this.route(url, init), work),
				),
			null,
		);
	}

	/** The edge executor's signed /turn/start and /jobs/start (executor.ts). */
	private async route(url: string, init?: RequestInit) {
		const request = new Request(url, init);
		const body = await request.clone().text();
		const secret = process.env.YTIMESY_BACKGROUND_WORKFLOW_SECRET ?? "";
		if (!(await verifyDeliveryRequest(secret, request, body)))
			return new Response(null, { status: 401 });
		// The deployed executor's routing order: a path its room router would
		// take never reaches the handlers below there, so not here either.
		const route = executorIngressRoute(new URL(url).pathname);
		// The web binding sends only the turn and job starts: anything routed
		// elsewhere is a routing bug the deployed edge would answer with 404.
		if (route !== "turn-start" && route !== "jobs-start") {
			this.errors.push(
				`executor binding: ${new URL(url).pathname} routed to ${route}`,
			);
			return new Response(null, { status: 404 });
		}
		if (route === "turn-start") {
			const turn = turnStartRequest.parse(JSON.parse(body));
			this.note(
				"admit",
				`${turn.sessionId.slice(0, 8)} turn ${turn.turnId.slice(0, 8)}`,
			);
			this.startTurn({
				id: turn.turnId,
				session_id: turn.sessionId,
				user_id: turn.userId,
				lease_id: turn.leaseId,
			} as ApiTurn);
			return new Response(null, { status: 204 });
		}
		if (route === "jobs-start") {
			await this.invoke(() =>
				this.dispatch(backgroundJob.parse(JSON.parse(body))),
			);
			return Response.json({ state: "queued" }, { status: 202 });
		}
		return new Response(null, { status: 404 });
	}

	private coordinate(action: TurnControlAction, turn: TurnControl) {
		const held = this.rooms.get(turn.sessionId);
		const same =
			held && held.turnId === turn.turnId && held.leaseId === turn.leaseId;
		switch (action) {
			case "acquire":
				if (held && !same) return false;
				this.rooms.set(turn.sessionId, turn);
				return true;
			case "renew":
				return Boolean(same);
			case "resume":
				if (held && !same) return false;
				this.rooms.set(turn.sessionId, turn);
				return true;
			case "release":
			case "handoff":
				if (same) this.rooms.delete(turn.sessionId);
				return true;
			case "cancel":
				return true;
		}
	}

	private track<T>(work: Promise<T>) {
		const tracked = work.catch((error) => {
			const text = String((error as Error)?.stack ?? error);
			// An expected deferral: the job runner logs it and the cron retries.
			if (text.includes("awaits the parent's next model safe point")) return;
			this.errors.push(text);
		});
		this.pending.add(tracked);
		tracked.finally(() => this.pending.delete(tracked));
		return tracked;
	}

	/** startBackgroundJob: idempotent per id, run in its own invocation. */
	private readonly jobs = new Set<string>();
	/** Memory jobs queued (recorded, not run). */
	readonly memoryJobs: {
		action: string;
		userId: string;
		sessionId: string | null;
	}[] = [];
	async dispatch(job: BackgroundJob) {
		if (this.jobs.has(job.id) || this.stopped) return;
		this.jobs.add(job.id);
		this.note("job", job.kind);
		this.track(this.invoke(() => this.runJob(job)));
	}

	private async runJob(job: BackgroundJob) {
		if (job.kind === "model-admission") return this.admit();
		// The save hook and dreams call a memory model the rehearsal has not
		// scripted; which chats queued them is what the checks need.
		if (job.kind === "memory") {
			this.memoryJobs.push({
				action: job.action,
				userId: job.userId,
				sessionId: job.sessionId ?? null,
			});
			return;
		}
		// Environment builds run in the ProjectEnvironment object; the rehearsal
		// prepares its VM with the hard-set setup instead.
		if (job.kind === "prepare") {
			this.errors.push(
				"A prepare job was dispatched; the rehearsal has no environment builds.",
			);
			return;
		}
		const outcome = await deliverBackgroundJob(this.input.machines, job);
		if (outcome === "pending") {
			// The job runner retries a pending peer message after 15 s; sooner here.
			this.jobs.delete(job.id);
			setTimeout(() => void this.dispatch(job), 2_000).unref();
		}
	}

	private async admit() {
		const limits = modelConcurrencyLimits();
		for (let count = 0; count < 16; count++) {
			const turn = await claimApiTurn(
				limits.perUser,
				limits.fleet,
				"durable-object",
			);
			if (!turn) break;
			if (!turn.lease_id) throw new Error("Claimed turn has no lease.");
			this.note(
				"admit",
				`${turn.session_id.slice(0, 8)} turn ${turn.id.slice(0, 8)}`,
			);
			this.startTurn(turn);
		}
	}

	/** ModelConversation.startTurn: one active turn per chat, the rest wait. */
	startTurn(turn: ApiTurn) {
		if (this.chats.has(turn.session_id)) {
			const queue = this.waiting.get(turn.session_id) ?? [];
			queue.push(turn);
			this.waiting.set(turn.session_id, queue);
			return;
		}
		const loop = this.track(this.invoke(() => this.runTurn(turn))).finally(
			() => {
				this.chats.delete(turn.session_id);
				const next = this.waiting.get(turn.session_id)?.shift();
				if (next) this.startTurn(next);
			},
		);
		this.chats.set(turn.session_id, loop as Promise<void>);
	}

	private async runTurn(turn: ApiTurn) {
		const leaseId = turn.lease_id as string;
		for (let index = 1; !this.stopped; index++) {
			const step = { turnId: turn.id, leaseId, index };
			let outcome: WorkflowStepOutcome | "unavailable";
			try {
				outcome = await executeModelStep(
					step,
					this.input.machines,
					{
						claim: (claimed, resumed) => this.claim(claimed, resumed),
						complete: async (finished, result) => {
							if (!this.steps.finish(finished, result))
								throw new Error("Conversation receipt was not saved.");
						},
					},
					AbortSignal.timeout(STEP_BUDGET_MS),
					false,
					WAIT_BUDGET_MS,
				);
			} catch (error) {
				this.errors.push(
					`step ${index} of ${turn.id.slice(0, 8)}: ${(error as Error).stack ?? error}`,
				);
				return;
			}
			this.note("step", `${turn.session_id.slice(0, 8)} #${index} ${outcome}`);
			if (outcome !== "continue") break;
		}
		// The edge admits the next queued turn when one ends.
		await this.dispatch({
			id: backgroundJobId(`completed:${turn.id}:${leaseId}`),
			kind: "model-admission",
		});
	}

	/** ModelConversation.claim, without the history cache and lease rotation. */
	private async claim(
		step: WorkflowStep,
		resume = false,
	): Promise<WorkflowStepClaim> {
		const receipt = this.steps.read(step);
		if (receipt?.state === "done" && receipt.outcome)
			return { kind: "done", outcome: receipt.outcome };
		if (receipt && !resume) return { kind: "unavailable" };
		const row = (
			await database().query<
				ApiTurn & { fresh: boolean; cancel_requested: boolean }
			>(
				`select t.id,t.session_id,t.user_id,t.connection_id,t.connection_revision,t.model_id,t.settings,t.failover,
				 t.state,t.lease_id,t.cancel_requested,t.messages,t.items,
				 heartbeat_at>=now()-interval '45 seconds' as fresh
				 from api_turn t where t.id=$1 and t.lease_id=$2 and t.executor='durable-object'`,
				[step.turnId, step.leaseId],
			)
		).rows[0];
		if (!row) return { kind: "unavailable" };
		if (["completed", "failed", "cancelled"].includes(row.state))
			return { kind: "done", outcome: row.state as WorkflowStepOutcome };
		if (row.state !== "running" || !row.fresh) return { kind: "unavailable" };
		if (row.cancel_requested) return { kind: "cancelled", turn: row };
		const claimed = claimConversationStep(this.steps, step, Date.now(), resume);
		return claimed.kind === "claimed" ? { ...claimed, turn: row } : claimed;
	}

	/** Whether a chat's turn loop (with its turn-end work) is still running. */
	isActive(sessionId: string) {
		return (
			this.chats.has(sessionId) || Boolean(this.waiting.get(sessionId)?.length)
		);
	}

	/** The cron's periodic jobs, every `ms`. */
	startCron(ms = 5_000) {
		const tick = async () => {
			if (this.cronBusy || this.stopped) return;
			this.cronBusy = true;
			const minute = randomUUID();
			try {
				await Promise.allSettled([
					this.invoke(() => this.admit()),
					...(["reconcile", "supervise", "delivery"] as const).map((action) =>
						this.invoke(() =>
							deliverBackgroundJob(this.input.machines, {
								id: backgroundJobId(`cron:${minute}:${action}`),
								kind: "maintenance",
								action,
							}),
						),
					),
					this.invoke(() =>
						deliverBackgroundJob(this.input.machines, {
							id: backgroundJobId(`cron:${minute}:task-event`),
							kind: "task-event",
							eventId: null,
						}),
					),
				]).then((results) => {
					for (const result of results)
						if (result.status === "rejected")
							this.errors.push(`cron: ${String(result.reason)}`);
				});
			} finally {
				this.cronBusy = false;
			}
		};
		this.cron = setInterval(() => void tick(), ms);
		void tick();
	}

	/** Waits until `done` holds (checked inside an invocation) or the deadline. */
	async until(done: () => Promise<boolean>, timeoutMs: number, label: string) {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				if (await this.invoke(done)) return;
			} catch {
				// A connection timeout on a loaded host; poll again.
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		throw new Error(`Timed out waiting for ${label}.`);
	}

	async stop() {
		this.stopped = true;
		if (this.cron) clearInterval(this.cron);
		await Promise.allSettled([...this.pending]);
	}
}
