import type { ModelMessage, ToolSet } from "ai";

export const PLAN_MODE_NOTICE =
	"Plan mode (set by the user for this message): investigate read-only and reply with a concrete plan — the approach, files to change, risks and the checks that will prove it works. Do not start writing tasks; the user approves the plan before implementation.";

const REFUSAL = {
	blocked: true,
	error:
		"Plan mode: implementation is paused until the user approves the plan. Reply with the plan instead.",
};

/** Tools that would begin writing work; read-only helpers and unstarted drafts stay available. */
function startsWritingWork(name: string, args: unknown) {
	if (
		[
			"launch_ready_tasks",
			"start_task",
			"integrate_reviewed_tasks",
			"schedule_task_plan",
			"control_task_plan",
			"import_reviewed_task",
		].includes(name)
	)
		return true;
	if (name !== "create_task") return false;
	const input = (args ?? {}) as {
		access?: unknown;
		startImmediately?: unknown;
	};
	return input.startImmediately === true && input.access !== "read_only";
}

/** Enforces plan mode server-side; prompts alone cannot be trusted to stop a writer. */
export function withPlanMode(tools: ToolSet): ToolSet {
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: (
						args: unknown,
						options: Parameters<NonNullable<typeof execute>>[1],
					) =>
						startsWritingWork(name, args)
							? Promise.resolve(REFUSAL)
							: execute(args as never, options),
				},
			];
		}),
	) as ToolSet;
}

/** Adds the notice once, after the user's message, so the cached prefix is kept. */
export function withPlanModeNotice(messages: ModelMessage[]): ModelMessage[] {
	return messages.some(
		(message) =>
			message.role === "user" &&
			typeof message.content === "string" &&
			message.content === PLAN_MODE_NOTICE,
	)
		? messages
		: [...messages, { role: "user", content: PLAN_MODE_NOTICE }];
}
