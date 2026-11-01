import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./local-import.fn", () => ({
	createLocalImportFn: vi.fn(),
	localImportStatusFn: vi.fn(),
	cancelLocalImportFn: vi.fn(),
}));

const { ContinueSessionCard, copyButtonLabel } = await import(
	"./continue-session-card"
);

it("reads Copied briefly after a copy, then Copy again", () => {
	expect(copyButtonLabel({ copied: false, justCopied: false })).toBe(
		"Copy prompt",
	);
	expect(copyButtonLabel({ copied: true, justCopied: true })).toBe("Copied");
	expect(copyButtonLabel({ copied: true, justCopied: false })).toBe(
		"Copy again",
	);
});

it("names each agent's mark in a tooltip", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ContinueSessionCard githubConnected />
		</QueryClientProvider>,
	);
	expect(html).toContain('title="Claude Code"');
	expect(html).toContain('title="Cursor"');
	expect(html).toContain('width="18"');
	expect(html).toContain("Copy prompt");
});
