import {
	Check,
	Circle,
	CornerDownRight,
	Pencil,
	Play,
	Plus,
	Square,
} from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";
import type { AgentTask } from "#/domain/agent-task";
import { MAX_AGENT_TASK_DEPTH } from "#/domain/agent-task";

export function TaskPanel({
	tasks,
	rootSessionId,
	busy,
	onCreate,
	onEdit,
	onStart,
	onWrapUp,
}: {
	tasks: readonly AgentTask[];
	rootSessionId: string;
	busy: boolean;
	onCreate: (input: {
		parentSessionId: string;
		title: string;
		prompt: string;
		placement: "shared" | "fresh";
		access: "read_only" | "read_write";
		execution: "parallel" | "stacked";
		dependsOnSessionId: string | null;
	}) => void;
	onEdit: (input: {
		taskSessionId: string;
		parentSessionId: string;
		title: string;
		prompt: string;
		placement: "shared" | "fresh";
		access: "read_only" | "read_write";
		execution: "parallel" | "stacked";
		dependsOnSessionId: string | null;
	}) => void;
	onStart: (taskSessionId: string) => void;
	onWrapUp: (taskSessionId: string) => void;
}) {
	const [draftingFor, setDraftingFor] = useState<string | null>(null);
	const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [access, setAccess] = useState<"read_only" | "read_write">(
		"read_write",
	);
	const [execution, setExecution] = useState<"parallel" | "stacked">(
		"parallel",
	);
	const [dependsOnSessionId, setDependsOnSessionId] = useState("");
	const parentSessionId = draftingFor ?? rootSessionId;
	const predecessors = tasks.filter(
		(task) =>
			task.parentSessionId === parentSessionId && task.id !== editingTaskId,
	);

	function edit(task: AgentTask) {
		setEditingTaskId(task.id);
		setDraftingFor(task.parentSessionId);
		setTitle(task.title);
		setPrompt(task.prompt);
		setAccess(task.access);
		setExecution(task.execution);
		setDependsOnSessionId(task.dependsOnSessionId ?? "");
	}

	function resetDraft() {
		setEditingTaskId(null);
		setDraftingFor(null);
		setTitle("");
		setPrompt("");
		setAccess("read_write");
		setExecution("parallel");
		setDependsOnSessionId("");
	}

	function submit() {
		const taskPrompt = prompt.trim();
		if (!taskPrompt || busy) return;
		const input: Parameters<typeof onCreate>[0] = {
			parentSessionId,
			title: title.trim() || taskPrompt.slice(0, 80),
			prompt: taskPrompt,
			placement: access === "read_only" ? "shared" : "fresh",
			access,
			execution,
			dependsOnSessionId:
				execution === "stacked" ? dependsOnSessionId || null : null,
		};
		if (editingTaskId) onEdit({ ...input, taskSessionId: editingTaskId });
		else onCreate(input);
		resetDraft();
	}

	return (
		<section className="task-panel" aria-label="Tasks">
			<header className="task-panel-header">
				<div>
					<strong>Tasks</strong>
					<span className="task-count">{tasks.length}</span>
				</div>
				<button type="button" onClick={resetDraft}>
					<Plus size={14} /> New task
				</button>
			</header>
			<div className="task-list">
				{tasks.length === 0 ? (
					<p className="task-empty">
						Draft independent work before starting child agents.
					</p>
				) : (
					tasks.map((task) => (
						<article
							className="task-row"
							key={task.id}
							style={{ "--task-depth": task.depth - 1 } as CSSProperties}
						>
							<span className="task-status" data-status={task.status}>
								{task.status === "done" ? (
									<Check size={13} />
								) : task.status === "working" ? (
									<Circle size={12} fill="currentColor" />
								) : (
									<Circle size={12} />
								)}
							</span>
							<div className="task-row-copy">
								<div>
									<span className="task-label">{task.label}</span>
									<strong>{task.title}</strong>
								</div>
								<small>
									{task.listedModelId ?? task.harnessId} · {task.status} ·{" "}
									{task.placement} · {task.execution}
								</small>
							</div>
							<div className="task-row-actions">
								{task.status === "draft" ? (
									<button type="button" title="Edit task draft" onClick={() => edit(task)}>
										<Pencil size={13} />
									</button>
								) : null}
								{task.status === "draft" || task.status === "idle" ? (
									<button
										type="button"
										title="Start task"
										onClick={() => onStart(task.id)}
									>
										<Play size={13} />
									</button>
								) : null}
								{task.depth < MAX_AGENT_TASK_DEPTH ? (
									<button
										type="button"
										title="Add child task"
										onClick={() => {
											resetDraft();
											setDraftingFor(task.id);
										}}
									>
										<CornerDownRight size={14} />
									</button>
								) : null}
								{task.status === "working" ? (
									<button
										type="button"
										title="Ask task to wrap up"
										onClick={() => onWrapUp(task.id)}
									>
										<Square size={12} />
									</button>
								) : null}
							</div>
						</article>
					))
				)}
			</div>
			<div className="task-draft">
				<label htmlFor="task-title">
					{editingTaskId ? "Edit task draft" : draftingFor ? "New child task" : "New task"}
				</label>
				<input
					id="task-title"
					className="task-title-field"
					value={title}
					onChange={(event) => setTitle(event.target.value)}
					placeholder="Title"
				/>
				<textarea
					className="task-prompt-field"
					value={prompt}
					onChange={(event) => setPrompt(event.target.value)}
					placeholder="Give this agent everything it needs; it starts from this prompt alone."
					rows={4}
				/>
				<div className="task-draft-options">
					<label>
						Access
						<select
							value={access}
							onChange={(event) =>
								setAccess(event.target.value as "read_only" | "read_write")
							}
						>
							<option value="read_write">Read and write · fresh machine</option>
							<option value="read_only">
								Read only · current parent state
							</option>
						</select>
					</label>
					<label>
						Execution
						<select
							value={execution}
							onChange={(event) => {
								const next = event.target.value as "parallel" | "stacked";
								setExecution(next);
								if (next === "parallel") setDependsOnSessionId("");
							}}
						>
							<option value="parallel">Parallel</option>
							<option value="stacked">Stacked</option>
						</select>
					</label>
					{execution === "stacked" ? (
						<label>
							Starts after
							<select
								value={dependsOnSessionId}
								onChange={(event) => setDependsOnSessionId(event.target.value)}
							>
								<option value="">Choose predecessor</option>
								{predecessors.map((task) => (
									<option key={task.id} value={task.id}>
										{task.label} · {task.title}
									</option>
								))}
							</select>
						</label>
					) : null}
				</div>
				<div>
					{draftingFor || editingTaskId ? (
						<button type="button" onClick={resetDraft}>
							Cancel
						</button>
					) : (
						<span />
					)}
					<button
						type="button"
						disabled={
							busy ||
							!prompt.trim() ||
							(execution === "stacked" && !dependsOnSessionId)
						}
						onClick={submit}
					>
						{editingTaskId ? "Save changes" : "Save draft"}
					</button>
				</div>
			</div>
		</section>
	);
}
