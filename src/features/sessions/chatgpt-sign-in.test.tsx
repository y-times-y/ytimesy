import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => ({}),
}));
vi.mock("./codex-session.fn", () => ({
	pollCodexLogin: vi.fn(),
	startChatgptSignIn: vi.fn(),
}));

vi.mock("./subscription-accounts.fn", () => ({
	startAddChatgptAccountFn: vi.fn(),
}));

import { ChatgptSignIn } from "./chatgpt-sign-in";

it("tells people to turn on device code sign-in in ChatGPT's security settings", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ChatgptSignIn />
		</QueryClientProvider>,
	);
	expect(html).toContain("<strong>Turn on device code sign-in</strong>");
	expect(html).toContain('href="https://chatgpt.com/#settings/Security"');
});

it("leaves the hint to a settings row that shows it below its description", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ChatgptSignIn showHint={false} />
		</QueryClientProvider>,
	);
	expect(html).toContain("Sign in with ChatGPT");
	expect(html).not.toContain("device code sign-in");
});
