import { Moon } from "lucide-react";
import type { MemoryDreamStatus } from "#/domain/memory-dream-schedule";

function when(iso: string, now: Date) {
	const date = new Date(iso);
	const sameDay = date.toDateString() === now.toDateString();
	const time = date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
	if (sameDay) return `today, ${time}`;
	return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

function day(iso: string) {
	return new Date(iso).toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});
}

function plural(count: number, one: string, many = `${one}s`) {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Dreaming at a glance: the background review that tidies memory after
 * chats go quiet, with a weekly pass over the whole repo. Read-only: it
 * runs on its own schedule.
 */
export function MemoryDreams({
	status,
	now = new Date(),
}: {
	status: MemoryDreamStatus | null | undefined;
	now?: Date;
}) {
	if (!status) return null;
	const change = status.lastChange;
	const summary = change?.summary;
	const counts = summary
		? [
				summary.added.length
					? plural(summary.added.length, "line added", "lines added")
					: null,
				summary.merged.length ? plural(summary.merged.length, "merge") : null,
				summary.resolved.length
					? plural(
							summary.resolved.length,
							"conflict resolved",
							"conflicts resolved",
						)
					: null,
				summary.expired.length
					? plural(
							summary.expired.length,
							"expired line retired",
							"expired lines retired",
						)
					: null,
				summary.removed.length
					? plural(summary.removed.length, "line removed", "lines removed")
					: null,
			].filter(Boolean)
		: [];
	const next =
		status.next.kind === "off"
			? "Paused while memory is off"
			: status.next.kind === "soon"
				? `Around ${when(status.next.at, now)}, once your chats have been quiet for 15 minutes`
				: "After your next chat goes quiet";
	return (
		<section className="memory-dreams" aria-label="Dreaming">
			<header>
				<Moon size={14} aria-hidden="true" />
				<h3>Dreaming</h3>
			</header>
			<p className="memory-dreams-lead">
				After your chats go quiet, the agent reviews them and tidies memory:
				saves what was missed, merges duplicates and retires lines a later chat
				replaced. Once a week it reviews everything.
			</p>
			<dl className="memory-dreams-facts">
				<div>
					<dt>Last run</dt>
					<dd>{status.lastRunAt ? when(status.lastRunAt, now) : "Not yet"}</dd>
				</div>
				<div>
					<dt>Next run</dt>
					<dd>{next}</dd>
				</div>
				<div>
					<dt>Weekly review</dt>
					<dd>
						{status.reviewDue
							? new Date(status.reviewDue) <= now
								? "Due with the next run"
								: `Next due ${day(status.reviewDue)}`
							: "With the next run"}
						{status.lastReviewAt ? (
							<span className="memory-muted">
								{" "}
								(last {day(status.lastReviewAt)})
							</span>
						) : null}
					</dd>
				</div>
			</dl>
			{change && summary ? (
				<div className="memory-dreams-change">
					<p>
						<span className="memory-muted">
							Last change, {when(change.at, now)}:
						</span>{" "}
						{change.message}
					</p>
					{counts.length ? (
						<p className="memory-dreams-counts">{counts.join(" · ")}</p>
					) : null}
					{counts.length ? (
						<details>
							<summary>What changed</summary>
							<ul>
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
						</details>
					) : null}
				</div>
			) : status.lastRunAt ? (
				<p className="memory-muted memory-dreams-change">
					No dream has changed memory recently.
				</p>
			) : null}
		</section>
	);
}
