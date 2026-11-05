import {
	Check,
	Circle,
	CircleAlert,
	Clock3,
	CornerDownRight,
} from "lucide-react";
import { type CSSProperties, useMemo, useState } from "react";
import { MatrixDotLoader } from "#/components/ui/matrix-dot-loader";
import { helperIdentities } from "#/domain/agent-panel";
import type { AgentTask, AgentTaskStatus } from "#/domain/agent-task";
import { foldFinished } from "#/domain/folded-list";
import { helperName, KIND_ICONS } from "#/domain/helper-names";
import type { SubagentTaskView } from "#/domain/subagent-tree";
import { formatSpend, totalSpend } from "#/domain/subagent-usage";
import { AgentIcon } from "./agent-icon";

const statusLabels: Record<AgentTaskStatus, string> = {
	draft: "Starting",
	working: "Working",
	waiting: "Waiting",
	idle: "Idle",
	done: "Completed",
	failed: "Failed",
};

type PanelTask = AgentTask & { readonly subagent?: SubagentTaskView };

/** Finished helpers that stay in view; older ones fold behind "Show N more". */
const FINISHED_HELPERS_SHOWN = 3;

/** `writer · fork · 41/150 steps · 6/30 min · 380k tok · $0.76 · 9.0 VM min` */
export function subagentUsageLine(view: SubagentTaskView) {
	const spend = formatSpend(view.subtree);
	const minutes = Math.round(view.minutes);
	return [
		view.role,
		view.vm,
		view.budget
			? `${view.steps}/${view.budget.steps} steps`
			: `${view.steps} steps`,
		view.budget ? `${minutes}/${view.budget.minutes} min` : `${minutes} min`,
		`${spend.tokens} tok`,
		spend.dollars,
		spend.vm,
	]
		.filter(Boolean)
		.join(" · ");
}

export function TaskPanel({ tasks }: { tasks: readonly PanelTask[] }) {
	// Short names and colours as the agents list gives them.
	const identities = useMemo(() => helperIdentities(tasks), [tasks]);
	const completed = tasks.filter((task) => task.status === "done").length;
	const [showAll, setShowAll] = useState(false);
	const folded = foldFinished(
		tasks,
		(task) => task.status === "done",
		FINISHED_HELPERS_SHOWN,
	);
	const shown = showAll ? tasks : folded.shown;
	const subagents = tasks.flatMap((task) =>
		task.subagent ? [task.subagent.spend] : [],
	);
	const treeSpend = subagents.length
		? formatSpend(totalSpend(subagents))
		: null;
	return (
		<section className="task-panel" aria-label="Subagents">
			<header className="task-panel-header">
				<h2>
					Subagents <span className="task-count">{tasks.length}</span>
				</h2>
				{tasks.length > 0 ? (
					<span className="task-count">
						{completed}/{tasks.length} completed
					</span>
				) : null}
			</header>
			{tasks.length === 0 ? (
				<p className="task-empty">Subagents appear here when Main starts them.</p>
			) : (
				<ol className="task-list">
					{shown.map((task) => {
						const identity = identities.get(task.id);
						return (
							<li
								className="task-row"
								key={task.id}
								style={
									{
										"--task-depth": Math.max(0, task.depth - 1),
									} as CSSProperties
								}
							>
								{task.depth > 1 ? (
									<CornerDownRight
										className="task-branch"
										size={14}
										aria-hidden="true"
									/>
								) : null}
								<span
									className="task-status"
									role="img"
									data-status={task.status}
									aria-label={statusLabels[task.status]}
								>
									{task.status === "done" ? (
										<Check size={14} />
									) : task.status === "failed" ? (
										<CircleAlert size={14} />
									) : task.status === "waiting" ? (
										<Clock3 size={14} />
									) : task.status === "working" ? (
										<MatrixDotLoader />
									) : (
										<Circle size={12} fill="none" />
									)}
								</span>
								<div className="task-row-copy">
									<div>
										{identity ? (
											<span className="task-agent">
												<AgentIcon
													icon={KIND_ICONS[identity.kind]}
													color={identity.color}
												/>
												<strong>{identity.name}</strong>
											</span>
										) : null}
										<span className="task-label">
											{identity?.task ?? helperName(task.title)}
										</span>
									</div>
									<small>
										{task.listedModelId ?? task.harnessId}
										<span aria-hidden="true"> · </span>
										{statusLabels[task.status]}
									</small>
									{task.subagent ? (
										<small className="task-usage">
											{subagentUsageLine(task.subagent)}
										</small>
									) : null}
								</div>
							</li>
						);
					})}
				</ol>
			)}
			{folded.hidden ? (
				<button
					type="button"
					className="list-fold-toggle"
					onClick={() => setShowAll((all) => !all)}
				>
					{showAll ? "Show less" : `Show ${folded.hidden} more done`}
				</button>
			) : null}
			{treeSpend ? (
				<p className="task-usage task-usage-total">
					Subagents {subagents.length} ·{" "}
					{[`${treeSpend.tokens} tok`, treeSpend.dollars, treeSpend.vm]
						.filter(Boolean)
						.join(" · ")}
				</p>
			) : null}
		</section>
	);
}
