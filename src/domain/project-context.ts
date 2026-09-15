export const PROJECT_CONTEXT_PATH = "/tmp/ytimesy-project-context.md";

export type ProjectTrace = {
	readonly area: string | null;
	readonly summary: string;
};

export function projectContextDocument(input: {
	readonly briefing: string;
	readonly traces: readonly ProjectTrace[];
}): string {
	const briefing = input.briefing.trim();
	const traces = input.traces
		.map((trace) => {
			const summary = trace.summary.trim();
			if (!summary) return null;
			const area = trace.area?.trim();
			return area ? `- ${area}: ${summary}` : `- ${summary}`;
		})
		.filter((line): line is string => Boolean(line));
	const parts: string[] = [];
	if (briefing) parts.push(`## Project briefing\n${briefing}`);
	if (traces.length) parts.push(`## Related traces\n${traces.join("\n")}`);
	return parts.join("\n\n");
}

export function relatedTracesForTask(
	traces: readonly ProjectTrace[],
	task: string,
	limit = 8,
): ProjectTrace[] {
	const words = task
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 3);
	const ranked = traces.map((trace, index) => {
		const hay = `${trace.area ?? ""} ${trace.summary}`.toLowerCase();
		const hits = words.reduce(
			(count, word) => count + (hay.includes(word) ? 1 : 0),
			0,
		);
		return { trace, hits, index };
	});
	const related = ranked.filter((row) => row.hits > 0);
	return (related.length > 0 ? related : ranked)
		.sort((left, right) => right.hits - left.hits || left.index - right.index)
		.slice(0, limit)
		.map((row) => row.trace);
}

export function traceSummaryFromTurn(input: {
	readonly task: string;
	readonly reply: string;
}): string | null {
	const task = input.task.trim().replace(/\s+/g, " ");
	const reply = input.reply.trim().replace(/\s+/g, " ");
	if (!task && !reply) return null;
	const summary = reply ? `${task || "Task"}: ${reply}` : task;
	return summary.length > 400 ? `${summary.slice(0, 399)}…` : summary;
}

export function nextProjectBriefing(input: {
	readonly briefing: string;
	readonly summary: string;
}): string {
	const briefing = input.briefing.trim();
	const summary = input.summary.trim();
	if (!summary) return briefing;
	if (!briefing) return clipBriefing(summary);
	if (briefing.includes(summary.slice(0, Math.min(80, summary.length)))) {
		return briefing;
	}
	return clipBriefing(`${briefing}\n${summary}`);
}

function clipBriefing(text: string) {
	return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
}
