import type { DynamicToolCallItem } from "./session-item";
import { AGENT_SEND_TOOL, AGENT_TOOL } from "./subagent";

/** An agent or agent_send call as its card shows it: who, what, on which model, and how it went. */
export type AgentCall = {
	readonly tool: "agent" | "agent_send";
	/** The subagent's positional id ("1", "1.2"). */
	readonly id?: string;
	readonly taskId?: string;
	readonly role?: string;
	readonly title?: string;
	readonly brief?: string;
	readonly message?: string;
	readonly model?: string;
	readonly explore: boolean;
	readonly stop: boolean;
	/** Lead mode fusion: this writer is the chat's persistent sidekick. */
	readonly sidekick: boolean;
	/** agent_send's status ("round 2/6 started"), or a waited reader's outcome. */
	readonly status?: string;
	/** A waited reader's report (wait: true), its header line removed. */
	readonly report?: string;
	/** The report's header facts: "14 steps · 3m · 120k tokens · $0.31". */
	readonly reportMeta?: string;
	readonly budget?: string;
	readonly note?: string;
	readonly modelNotice?: string;
};

function record(text: string | undefined): Record<string, unknown> {
	if (!text) return {};
	try {
		let value = JSON.parse(text);
		if (value?.type === "json") value = value.value;
		return value && typeof value === "object" ? value : {};
	} catch {
		return {};
	}
}

/** The card data of an agent or agent_send call; null for any other tool. */
export function agentCall(item: DynamicToolCallItem): AgentCall | null {
	if (item.tool !== AGENT_TOOL && item.tool !== AGENT_SEND_TOOL) return null;
	const input = record(item.input);
	const output = record(item.output);
	const text = (source: Record<string, unknown>, key: string) => {
		const value = source[key];
		return typeof value === "string" && value.trim()
			? value
			: typeof value === "number"
				? String(value)
				: undefined;
	};
	const rawReport = text(output, "report");
	const header = rawReport
		? /^\[agent \S+ \S+ ([^\]]+)\]\s*/.exec(rawReport)
		: null;
	const budget = output.budget as
		| { steps?: number; minutes?: number }
		| undefined;
	return {
		tool: item.tool === AGENT_TOOL ? "agent" : "agent_send",
		id: text(output, "id") ?? text(input, "id"),
		taskId: text(output, "taskId"),
		role: text(input, "role") ?? text(output, "role"),
		title: text(input, "title"),
		brief: text(input, "brief"),
		message: text(input, "message"),
		model: text(output, "model"),
		explore: input.explore === true,
		stop: input.stop === true,
		sidekick: Boolean(text(output, "sidekick")),
		status: text(output, "status") ?? text(output, "outcome"),
		report: header && rawReport ? rawReport.slice(header[0].length) : rawReport,
		reportMeta: header?.[1],
		budget:
			budget && typeof budget.steps === "number"
				? `${budget.steps} steps · ${budget.minutes ?? "?"} min budget`
				: undefined,
		note: text(output, "note"),
		modelNotice: text(output, "modelNotice"),
	};
}
