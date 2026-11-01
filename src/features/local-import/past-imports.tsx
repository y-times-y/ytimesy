import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowUpRight } from "lucide-react";
import {
	type FinishedImportView,
	LOCAL_AGENT_NAMES,
	shortDay,
} from "#/domain/local-import-view";
import { LocalAgentMark } from "./local-agent-mark";
import { finishedLocalImportsFn } from "./local-import.fn";

/** One finished import's line: "Claude Code · 3 sessions · Nov 1". */
export function pastImportLine(entry: FinishedImportView) {
	return [
		entry.agent ? LOCAL_AGENT_NAMES[entry.agent] : "Local agent",
		`${entry.sessions} ${entry.sessions === 1 ? "session" : "sessions"}`,
		shortDay(entry.finishedAt),
	].join(" · ");
}

export function PastImportList({
	imports,
}: {
	imports: readonly FinishedImportView[];
}) {
	if (!imports.length) return null;
	return (
		<section className="settings-group" aria-label="Past imports">
			{imports.map((entry) => (
				<div key={entry.id} className="settings-row">
					<div className="settings-row-main">
						<span className="settings-row-icon">
							{entry.agent ? (
								<LocalAgentMark agent={entry.agent} size={16} />
							) : null}
						</span>
						<div className="settings-row-text">
							<span className="settings-row-title">{entry.projectName}</span>
							<span className="settings-row-meta">{pastImportLine(entry)}</span>
						</div>
					</div>
					{entry.sessionId ? (
						<div className="settings-row-actions">
							<a
								className="settings-secondary"
								href={`/?project=${entry.projectId}&chat=${entry.sessionId}`}
							>
								Open chat
								<ArrowUpRight size={14} aria-hidden="true" />
							</a>
						</div>
					) : null}
				</div>
			))}
		</section>
	);
}

/** Settings > Import: finished imports, newest first, each linking to its chat. */
export function PastImports() {
	const read = useServerFn(finishedLocalImportsFn);
	const imports = useQuery({
		queryKey: ["local-imports", "finished"],
		queryFn: () => read(),
	});
	return <PastImportList imports={imports.data ?? []} />;
}
