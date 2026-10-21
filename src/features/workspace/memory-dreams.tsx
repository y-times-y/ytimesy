import { ChevronRight, Moon } from "lucide-react";
import { useState } from "react";
import type { MemoryDreamStatus } from "#/domain/memory-dream-schedule";
import { MemoryInfo } from "./memory-info";

function time(iso: string) {
	return new Date(iso).toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

function when(iso: string, now: Date) {
	const date = new Date(iso);
	if (date.toDateString() === now.toDateString()) return `today ${time(iso)}`;
	return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time(iso)}`;
}

function day(iso: string) {
	return new Date(iso).toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
	});
}

/**
 * Dreaming in two lines: when it last ran with what it changed (the list
 * behind "Changes"), and when it runs next. The rest is in the (i).
 */
export function MemoryDreams({
	status,
	now = new Date(),
}: {
	status: MemoryDreamStatus | null | undefined;
	now?: Date;
}) {
	const [open, setOpen] = useState(false);
	if (!status) return null;
	const summary = status.lastChange?.summary;
	const counts = summary
		? [
				summary.added.length ? `${summary.added.length} added` : null,
				summary.merged.length ? `${summary.merged.length} merged` : null,
				summary.resolved.length ? `${summary.resolved.length} replaced` : null,
				summary.expired.length ? `${summary.expired.length} expired` : null,
				summary.removed.length ? `${summary.removed.length} removed` : null,
			].filter(Boolean)
		: [];
	const next =
		status.next.kind === "off"
			? "paused (memory is off)"
			: status.next.kind === "soon"
				? `about ${status.next.at && new Date(status.next.at).toDateString() === now.toDateString() ? time(status.next.at) : when(status.next.at, now)}`
				: "after your next chat";
	return (
		<section className="memory-dreams" aria-label="Dreaming">
			<header>
				<Moon size={14} aria-hidden="true" />
				<h3>Dreaming</h3>
				<span className="memory-dreams-tagline">
					tidies memory while you're away
				</span>
				<MemoryInfo label="About dreaming">
					About 15 minutes after your chats go quiet, the agent reviews them:
					saves what was missed, merges duplicates and retires lines a later
					chat replaced. Once a week it reviews all of memory
					{status.reviewDue ? ` (next ${day(status.reviewDue)})` : ""}.
				</MemoryInfo>
			</header>
			<dl className="memory-dreams-facts">
				<div>
					<dt>Last</dt>
					<dd>
						{status.lastRunAt ? when(status.lastRunAt, now) : "not yet"}
						{counts.length ? ` · ${counts.join(", ")}` : ""}
						{counts.length ? (
							<button
								type="button"
								className="memory-dreams-toggle"
								aria-expanded={open}
								onClick={() => setOpen((value) => !value)}
							>
								Changes
								<ChevronRight size={12} aria-hidden="true" />
							</button>
						) : null}
					</dd>
				</div>
				<div>
					<dt>Next</dt>
					<dd>{next}</dd>
				</div>
			</dl>
			{open && summary ? (
				<ul className="memory-dreams-changes">
					{summary.merged.map((merge) => (
						<li key={`m:${merge.into}`} data-change="merged">
							<span>Merged</span>
							<div>
								<p>{merge.into}</p>
								{merge.from.map((line) => (
									<p key={line} className="memory-dreams-old">
										{line}
									</p>
								))}
							</div>
						</li>
					))}
					{summary.resolved.map((line) => (
						<li key={`r:${line}`} data-change="resolved">
							<span>Replaced</span>
							<p className="memory-dreams-old">{line}</p>
						</li>
					))}
					{summary.expired.map((line) => (
						<li key={`e:${line}`} data-change="expired">
							<span>Expired</span>
							<p className="memory-dreams-old">{line}</p>
						</li>
					))}
					{summary.removed.map((line) => (
						<li key={`d:${line}`} data-change="removed">
							<span>Removed</span>
							<p className="memory-dreams-old">{line}</p>
						</li>
					))}
					{summary.added.map((line) => (
						<li key={`a:${line}`} data-change="added">
							<span>Added</span>
							<p>{line}</p>
						</li>
					))}
				</ul>
			) : null}
		</section>
	);
}
