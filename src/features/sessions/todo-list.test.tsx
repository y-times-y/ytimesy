import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentTodo } from "#/domain/agent-todos";
import { ChatRefreshingContext } from "./chat-refreshing";
import { TodoList } from "./todo-list";

const todos: AgentTodo[] = [
	{ text: "Write it", status: "completed" },
	{ text: "Test it", status: "in_progress" },
	{ text: "Ship it", status: "pending" },
];

describe("TodoList", () => {
	it("spins the todo in progress while the agent works", () => {
		const html = renderToStaticMarkup(<TodoList todos={todos} live />);
		expect(html).toContain("todo-status-spin");
		expect(html).toContain('aria-label="In progress"');
	});
	it("does not spin once the turn is over, and says it is unfinished", () => {
		const html = renderToStaticMarkup(<TodoList todos={todos} live={false} />);
		expect(html).not.toContain("todo-status-spin");
		expect(html).toContain('aria-label="Not finished"');
		expect(html).toContain("data-idle");
	});
	it("keeps the spinner by default for places with no turn to ask", () => {
		expect(renderToStaticMarkup(<TodoList todos={todos} />)).toContain(
			"todo-status-spin",
		);
	});
});

describe("TodoList while the chat is refreshing", () => {
	it("does not spin a todo from a saved copy that may be old", () => {
		const html = renderToStaticMarkup(
			<ChatRefreshingContext.Provider value={true}>
				<TodoList todos={todos} live />
			</ChatRefreshingContext.Provider>,
		);
		expect(html).not.toContain("todo-status-spin");
		expect(html).toContain('aria-label="Not finished"');
	});
});
