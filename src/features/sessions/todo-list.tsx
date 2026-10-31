import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { AgentTodo } from "#/domain/agent-todos";
import { foldFinished } from "#/domain/folded-list";

/** Past this many done todos, the done ones fold into one "N done" row. */
const DONE_TODOS_SHOWN = 6;

export function TodoList({ todos }: { todos: readonly AgentTodo[] }) {
	const [showDone, setShowDone] = useState(false);
	const done = todos.filter((todo) => todo.status === "completed").length;
	const folded =
		done > DONE_TODOS_SHOWN && !showDone
			? foldFinished(todos, (todo) => todo.status === "completed", 0)
			: { shown: todos, hidden: 0 };
	return (
		<section className="overview-section overview-todos" aria-label="Todos">
			<h2>
				Todos{" "}
				<span>
					{todos.filter((todo) => todo.status === "completed").length}/
					{todos.length}
				</span>
			</h2>
			{done > DONE_TODOS_SHOWN ? (
				<button
					type="button"
					className="list-fold-toggle"
					onClick={() => setShowDone((all) => !all)}
				>
					{showDone ? "Hide done" : `${folded.hidden} done`}
				</button>
			) : null}
			<ol>
				{folded.shown.map((todo, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Provider todo snapshots have no IDs and may repeat text; these rows hold no local state.
					<li key={`${index}:${todo.text}`} data-status={todo.status}>
						<span
							className="todo-status"
							role="img"
							aria-label={
								todo.status === "completed"
									? "Completed"
									: todo.status === "in_progress"
										? "In progress"
										: "Pending"
							}
						>
							{todo.status === "completed" ? (
								<CircleCheck size={16} />
							) : todo.status === "in_progress" ? (
								<LoaderCircle size={16} className="todo-status-spin" />
							) : (
								<Circle size={16} />
							)}
						</span>
						{todo.status === "completed" ? (
							<s>{todo.text}</s>
						) : (
							<span>{todo.text}</span>
						)}
					</li>
				))}
			</ol>
		</section>
	);
}
