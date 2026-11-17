import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { childTaskEventQueueText } from "../../domain/child-task-activity";
import { wakeMessageId } from "../../domain/pull-request-wake";
import {
	type CrewRow,
	parseCrewNote,
	parseCrewWaitingHint,
} from "../../domain/y-squared-crew";
import {
	parseScheduleCreate,
	parseSettingsPatch,
	scheduleInput,
} from "../../domain/y-squared-proactive";
import { agentSessionMetadataForOwner } from "../adapters/agent-sessions";
import { withDatabaseScope } from "../adapters/database-scope";
import { readFreestyleApiKey } from "../adapters/freestyle/api-key";
import { createFreestyleWorkspaceMachines } from "../adapters/freestyle/workspace-machines";
import type { YSquaredScheduleResult } from "../adapters/y-squared-crew-client";
import { sendComposerMessage } from "../services/queued-user-messages";
import { runCrewAlarm } from "./crew-alarm";
import type { EdgeExecutorEnvironment } from "./environment";
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

	/** Y²'s `schedule` tool: create, list or cancel. One alarm slot: a new schedule only moves it earlier. */
	async schedule(
		raw: unknown,
		target: { userId: string; ySquaredId: string },
	): Promise<YSquaredScheduleResult> {
		const parsed = scheduleInput.safeParse(raw);
		if (!parsed.success)
			return { ok: false, error: "That schedule request is not valid." };
		const input = parsed.data;
		const now = Date.now();
		if (input.action === "list")
			return { ok: true, action: "list", schedules: this.store.schedules() };
		if (input.action === "cancel") {
			if (!input.id)
				return { ok: false, error: "Cancel needs the schedule's id." };
			return {
				ok: true,
				action: "cancel",
				cancelled: this.store.cancelSchedule(input.id),
			};
		}
		const saved = this.store.settings().timezone;
		const draft = parseScheduleCreate(input, { now, timezone: saved });
		if (!draft.ok) return draft;
		const created = this.store.createSchedule(draft.draft, target, now);
		if (!created.ok) return created;
		if (created.alarmAt !== null)
			await this.ctx.storage.setAlarm(created.alarmAt);
		return {
			ok: true,
			action: "create",
			schedule: created.schedule,
			usedUtcFallback: !saved && !input.timezone,
		};
	}

	/** Settings (stall nudges, time zone), active schedules and today's proactive-wake count. */
	async proactive() {
		return this.store.proactiveStatus(Date.now());
	}

	async saveSettings(raw: unknown) {
		const { settings, alarmAt } = this.store.saveSettings(
			parseSettingsPatch(raw),
			Date.now(),
		);
		if (alarmAt !== null) await this.ctx.storage.setAlarm(alarmAt);
		return settings;
	}

	async cancelSchedule(id: string) {
		return this.store.cancelSchedule(String(id).slice(0, 64));
	}

	/** The cold start's one fill from the sidebar's metadata. */
	async reconcile(rows: readonly CrewRow[]) {
		this.store.reconcile(rows);
	}

	async alarm() {
		await runCrewAlarm({
			store: this.store,
			now: Date.now(),
			enqueue: (target, at, body) => this.enqueueWake(target, at, body),
			setAlarm: (at) => this.ctx.storage.setAlarm(at),
			log: (line) => console.log(line),
		});
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
				if (!chat?.listedModelId) return false;
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
				return true;
			},
			null,
		);
	}
}
