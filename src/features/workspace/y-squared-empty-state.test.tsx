import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Y_SQUARED_SUGGESTIONS } from "#/domain/y-squared";
import { YSquaredEmptyState } from "./y-squared-empty-state";

type Props = { children?: unknown; onClick?: () => void; type?: string };

function buttons(node: unknown): ReactElement<Props>[] {
	if (!isValidElement<Props>(node)) return [];
	if (node.type === "button") return [node];
	return Children.toArray(node.props.children as never).flatMap(buttons);
}

it("says what Y² is for and offers three questions", () => {
	const html = renderToStaticMarkup(<YSquaredEmptyState onSend={() => {}} />);
	expect(html).toContain(
		"Super agent keeps track of this project&#x27;s threads.",
	);
	expect(html).not.toContain("Y²");
	expect(html.match(/<button type="button"/g)).toHaveLength(3);
	expect(Y_SQUARED_SUGGESTIONS).toEqual([
		"What needs me?",
		"What's running?",
		"Summarize today",
	]);
});

it("sends a suggestion when it is clicked", () => {
	const sent: string[] = [];
	const tree = YSquaredEmptyState({ onSend: (text) => sent.push(text) });
	const [first, , last] = buttons(tree);
	first?.props.onClick?.();
	last?.props.onClick?.();
	expect(sent).toEqual(["What needs me?", "Summarize today"]);
});
