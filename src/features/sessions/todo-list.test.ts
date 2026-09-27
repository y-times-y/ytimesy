import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TodoList } from "./todo-list";

it("strikes through only completed todos without interactive controls", () => {
	const html = renderToStaticMarkup(
		createElement(TodoList, {
			todos: [
				{ text: "Inspect", status: "completed" },
				{ text: "Test", status: "in_progress" },
			],
		}),
	);
	expect(html).toContain("1/2");
	expect(html).toContain("<s>Inspect</s>");
	expect(html).not.toContain("<s>Test</s>");
	expect(html).not.toMatch(/<(input|button|select)\b/);
});
