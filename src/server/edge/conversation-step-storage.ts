import type {
	ConversationStepStorage,
	StepReceipt,
} from "../../domain/conversation-step-receipts";
import type {
	WorkflowStep,
	WorkflowStepOutcome,
} from "../../domain/model-workflow";

/** SQLite is the sole receipt authority for turns admitted to this DO executor. */
export class SqliteConversationSteps implements ConversationStepStorage {
	constructor(private readonly sql: SqlStorage) {
		sql.exec(`create table if not exists model_step (
			turn_id text not null, lease_id text not null, step_index integer not null,
			state text not null check(state in ('processing','done')),
			outcome text, started_at integer not null,
			primary key(turn_id,lease_id,step_index))`);
	}
	read(step: WorkflowStep): StepReceipt | undefined {
		return this.sql
			.exec<StepReceipt>(
				"select state,outcome,started_at as startedAt from model_step where turn_id=? and lease_id=? and step_index=?",
				step.turnId,
				step.leaseId,
				step.index,
			)
			.toArray()[0];
	}
	firstStartedAt(step: WorkflowStep) {
		return this.sql
			.exec<{ startedAt: number }>(
				"select started_at as startedAt from model_step where turn_id=? and lease_id=? order by step_index limit 1",
				step.turnId,
				step.leaseId,
			)
			.toArray()[0]?.startedAt;
	}
	insert(step: WorkflowStep, startedAt: number) {
		this.sql.exec(
			"insert into model_step values(?,?,?,'processing',null,?)",
			step.turnId,
			step.leaseId,
			step.index,
			startedAt,
		);
	}
	finish(step: WorkflowStep, outcome: WorkflowStepOutcome) {
		return (
			this.sql
				.exec(
					"update model_step set state='done',outcome=? where turn_id=? and lease_id=? and step_index=? and state='processing' returning turn_id",
					outcome,
					step.turnId,
					step.leaseId,
					step.index,
				)
				.toArray().length === 1
		);
	}
}
