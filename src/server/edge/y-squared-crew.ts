import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { childTaskEventQueueText } from "../../domain/child-task-activity";
import { wakeMessageId } from "../../domain/pull-request-wake";
import {
	type CrewRow,
	parseCrewNote,
	parseCrewWaitingHint,
} from "../../domain/y-squared-crew";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { withDatabaseScope } from "../adapters/database-scope";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import { sendComposerMessage } from "../services/queued-user-messages";
import type { EdgeExecutorEnvironment } from "./environment";
import { stepFailureCause } from "./step-failure-cause";
import { SqliteYSquaredCrew } from "./y-squared-crew-store";

/**
 * One Y project's crew (src/domain/y-squared-crew.ts): a row per thread,
 * pushed by each thread's ModelConversation when its turn starts and settles,
 * and Y²'s debounced wake. Named by the project id. Asleep between notes:
 * the only alarm is a pending wake, never a poll.
 */
export class YSquaredCrew extends DurableObject<EdgeExecutorEnvironment> {
	private readonly store: SqliteYSquaredCrew;
	constructor(ctx: DurableObjectState, env: EdgeExecutorEnvironment) {
		super(ctx, env);
		this.store = new SqliteYSquaredCrew(ctx.storage.sql);
	}

	/** A thread's turn started or settled (RPC from its ModelConversation). */
	async noteThread(raw: unknown) {
		const note = parseCrewNote(raw);
		if (!note) return;
		const { alarmAt } = this.store.noteThread(note, Date.now());
		if (alarmAt !== null) await this.ctx.storage.setAlarm(alarmAt);
	}

	/** A thread's turn ended on a card for the person (api-turn.ts); merged into its settle note. */
	async noteWaiting(raw: unknown) {
		const hint = parseCrewWaitingHint(raw);
		if (!hint) return;
		const { alarmAt } = this.store.noteWaiting(hint, Date.now());
		if (alarmAt !== null) await this.ctx.storage.setAlarm(alarmAt);
	}

	/** Y² is about to send into a thread (null: a new one); its turn start is then not the person's. */
	async noteY2Sent(sessionId: string | null) {
		this.store.noteY2Sent(
			typeof sessionId === "string" ? sessionId.slice(0, 64) : null,
			Date.now(),
		);
	}

	/** The threads, needing-person first; one request for Y²'s `threads` tool. */
	async list() {
		return this.store.list();
	}

	async thread(sessionId: string) {
		return this.store.thread(sessionId);
	}

	/** The cold start's one fill from the sidebar's metadata. */
	async reconcile(rows: readonly CrewRow[]) {
		this.store.reconcile(rows);
	}

	async alarm() {
		const decided = this.store.takeWake(Date.now());
		if (decided.action === "capped") {
			if (decided.retryAt !== undefined)
				await this.ctx.storage.setAlarm(decided.retryAt);
			return;
		}
		if (decided.action === "none") {
			if (decided.rearmAt !== null)
				await this.ctx.storage.setAlarm(decided.rearmAt);
			return;
		}
		// The next heartbeat, if a thread is still working.
		if (decided.rearmAt !== null)
			await this.ctx.storage.setAlarm(decided.rearmAt);
		const target = this.store.target();
		if (!target) return;
		try {
			await this.enqueueWake(target, decided.next.lastWakeAt, decided.body);
			this.store.wakeSent(decided.eventsUpTo);
		} catch (error) {
			console.warn("Y² was not woken.", { cause: stepFailureCause(error) });
			this.store.returnWake();
		}
	}

	/** Exactly one Y² turn, through the same send path as a person's message. */
	private enqueueWake(
		target: { userId: string; sessionId: string },
		at: number,
		body: string,
	) {
		return withDatabaseScope(
			this.env.HYPERDRIVE.connectionString,
			async () => {
				const chat = await agentSessionMetadataForOwner(
					target.userId,
					target.sessionId,
				);
				if (!chat?.listedModelId) return;
				await Effect.runPromise(
					sendComposerMessage(
						createFreestyleWorkspaceMachines(
							Effect.runSync(readFreestyleApiKey()),
						),
						{
							userId: target.userId,
							projectId: chat.projectId,
							sessionId: chat.id,
							harnessId: chat.harness,
							createNew: false,
						},
						{
							text: `${childTaskEventQueueText(`y2:${at}`)}\n${body}`,
							modelId: chat.listedModelId,
							idempotencyKey: wakeMessageId(`y2:${target.sessionId}:${at}`),
						},
					),
				);
			},
			null,
		);
	}
}
