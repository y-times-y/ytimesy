import type { SessionItem } from "./session-item";

export const PROJECT_CONTEXT_PATH = "/tmp/ytimesy-project-context.md";

export type ProjectTrace = {
	readonly area: string | null;
	readonly summary: string;
};

export function projectContextDocument(input: {
	readonly briefing: string;
	readonly traces: readonly ProjectTrace[];
}): string {
	const briefing = briefingLinesNewestFirst(input.briefing);
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
	const durable = durableProjectTraces(traces);
	const words = task
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 3);
	const ranked = durable.map((trace, index) => {
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

/**
 * Exact-reply pings are not how a sibling figured out the repo. Keep
 * traces that touched an area or recorded reasoning.
 */
export function completedTurnUpdatesProjectContext(input: {
	readonly area: string | null;
	readonly task: string;
	readonly reply: string;
	readonly reasoning?: readonly string[];
}): boolean {
	if (input.area?.trim()) return true;
	if ((input.reasoning ?? []).some((line) => line.trim())) return true;
	if (isExactReplyEcho(input.task, input.reply)) return false;
	const reply = input.reply.trim();
	return Boolean(reply.includes(" ") || reply.length > 80);
}

export function durableProjectTraces(
	traces: readonly ProjectTrace[],
): ProjectTrace[] {
	return traces.filter(
		(trace) =>
			Boolean(trace.area?.trim()) || !isExactReplyEchoTrace(trace.summary),
	);
}

export function briefingUpdateFromTurn(input: {
	readonly task: string;
	readonly reply: string;
}): string | null {
	const task = input.task.trim().replace(/\s+/g, " ");
	const reply = input.reply.trim().replace(/\s+/g, " ");
	if (!task && !reply) return null;
	const summary = reply ? `${task || "Task"}: ${reply}` : task;
	return summary.length > 400 ? `${summary.slice(0, 399)}…` : summary;
}

export function traceSummaryFromTurn(input: {
	readonly task: string;
	readonly reply: string;
	readonly reasoning?: readonly string[];
}): string | null {
	const fact = briefingUpdateFromTurn({
		task: input.task,
		reply: input.reply,
	});
	if (!fact) return null;
	const how = (input.reasoning ?? [])
		.map((summary) => summary.trim().replace(/\s+/g, " "))
		.filter(Boolean)
		.join(" ");
	if (!how) return fact;
	const combined = `${fact}\nHow: ${how}`;
	return combined.length > 800 ? `${combined.slice(0, 799)}…` : combined;
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
	const lines = `${briefing}\n${summary}`
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	return clipBriefing(lines.slice(-6).join("\n"));
}

export function promptTextWithProjectContext(input: {
	readonly task: string;
	readonly document: string;
}): string {
	const document = input.document.trim();
	const task = input.task;
	if (!document) return task;
	return `Shared project context from sibling agents:\n\n${document}\n\n---\n\n${task}`;
}

/**
 * Related traces key off this path so the next agent gets how a sibling
 * figured out the same area, not every thought from every session.
 */
export function traceAreaFromTurn(input: {
	readonly task: string;
	readonly items: readonly SessionItem[];
}): string | null {
	return fileChangeAreaFromTurn(input.items) ?? traceAreaFromTask(input.task);
}

export function traceAreaFromTask(task: string): string | null {
	const paths = [
		...task.matchAll(
			/(?<![A-Za-z0-9_./-])((?:src|tests|public|scripts|\.agents)\/[\w./-]+|[\w.-]+\.(?:md|ts|tsx|css|json))/g,
		),
	].map((match) => match[1]);
	return areaFromPaths(paths);
}

function fileChangeAreaFromTurn(items: readonly SessionItem[]): string | null {
	let start = 0;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index]?.kind === "userMessage") start = index + 1;
	}
	const paths: string[] = [];
	for (const item of items.slice(start)) {
		if (item.kind !== "fileChange") continue;
		for (const change of item.changes) {
			const path = change.path.trim();
			if (path) paths.push(path);
		}
	}
	return areaFromPaths(paths);
}

function areaFromPaths(paths: readonly string[]): string | null {
	const unique = [
		...new Set(paths.map((path) => path.replace(/^\.\//, "")).filter(Boolean)),
	];
	if (unique.length === 0) return null;
	if (unique.length === 1) return unique[0] ?? null;
	const directories = unique.map((path) => {
		const slash = path.lastIndexOf("/");
		return slash === -1 ? path : path.slice(0, slash);
	});
	const common = directories[0];
	if (
		common &&
		directories.every(
			(directory) => directory === common || directory.startsWith(`${common}/`),
		)
	) {
		return common;
	}
	return unique[0] ?? null;
}

function clipBriefing(text: string) {
	return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
}

function briefingLinesNewestFirst(briefing: string): string {
	return briefing
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !isPingBriefingLine(line))
		.reverse()
		.join("\n");
}

function isExactReplyEcho(task: string, reply: string): boolean {
	const token = reply.trim();
	if (!token || token.length > 80 || /\s/.test(token)) return false;
	const normalized = task.toLowerCase();
	return (
		normalized.includes("reply with exactly") &&
		normalized.includes(token.toLowerCase())
	);
}

function isExactReplyEchoTrace(summary: string): boolean {
	if (/\nHow:/i.test(summary)) return false;
	return /^reply with exactly .+: \S{1,80}$/i.test(summary.trim());
}

function isPingBriefingLine(line: string): boolean {
	if (isExactReplyEchoTrace(line)) return true;
	return /do not edit files\.: \S{1,80}$/i.test(line);
}
