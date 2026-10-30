import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => ({}),
}));
vi.mock("../sessions/chatgpt-sign-in", () => ({
	ChatgptSignIn: () => <button type="button">Sign in with ChatGPT</button>,
}));
vi.mock("../sessions/codex-session.fn", () => ({
	pollCodexLogin: vi.fn(),
	startChatgptSignIn: vi.fn(),
}));
vi.mock("../sessions/model-connections.fn", () => ({
	getModelConnections: vi.fn(),
}));
vi.mock("../sessions/model-connections", () => ({
	ModelConnections: () => null,
}));
vi.mock("../projects/github-connection-notice", () => ({
	useGithubConnectionNotice: () => [null],
}));
vi.mock("../projects/add-project-form", () => ({
	AddProjectForm: () => <div data-testid="add-project" />,
}));

import { FirstRun } from "./first-run";

function render(state: { githubConnected: boolean; modelReady: boolean }) {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<FirstRun state={state} />
		</QueryClientProvider>,
	);
}

it("opens at GitHub, or at the repositories once GitHub is connected", () => {
	const fresh = render({ githubConnected: false, modelReady: false });
	expect(fresh).toContain("Connect GitHub");
	expect(fresh).toContain('data-state="current"><span class="first-run-dot">1');
	const connected = render({ githubConnected: true, modelReady: false });
	expect(connected).toContain("Pick your repositories");
	expect(connected).toContain('data-state="done"');
});

import { ModelStep } from "./first-run";

it("offers the Codex subscription or an API key, and Later until one is set", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} />
		</QueryClientProvider>,
	);
	expect(html).toContain("Your Codex subscription");
	expect(html).toContain("Sign in with ChatGPT");
	expect(html).toContain("Your API key");
	expect(html).toContain("Later");
	const ready = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready />
		</QueryClientProvider>,
	);
	expect(ready).not.toContain("Later");
});
