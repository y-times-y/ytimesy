import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ContextUsage } from "./context-usage";

vi.mock("#/components/ui/popover", () => ({
	Popover: ({ children }: { children: ReactNode }) => children,
	PopoverTrigger: ({ children }: { children: ReactNode }) => (
		<button type="button">{children}</button>
	),
	PopoverContent: ({ children }: { children: ReactNode }) => (
		<div>{children}</div>
	),
}));

describe("context usage", () => {
	it("shows the reported token total, capacity and percentage", () => {
		const html = renderToStaticMarkup(
			<ContextUsage
				context={{ last: { totalTokens: 239000 }, modelContextWindow: 258000 }}
			/>,
		);
		expect(html).toContain("Context window:");
		expect(html).toContain("93% full");
		expect(html).toContain("239K / 258K tokens used");
	});
	it("hides the ring without a reading", () => {
		expect(renderToStaticMarkup(<ContextUsage />)).toBe("");
	});
	it("shows compaction without inventing usage", () => {
		const html = renderToStaticMarkup(<ContextUsage compacting />);
		expect(html).toContain("Compacting context…");
		expect(html).not.toContain("tokens used");
	});
});
