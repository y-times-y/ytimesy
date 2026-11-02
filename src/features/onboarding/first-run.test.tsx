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
vi.mock("../sessions/xai-subscription-sign-in", () => ({
	XaiSubscriptionSignIn: () => <button type="button">Sign in with xAI</button>,
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
vi.mock("../local-import/local-import.fn", () => ({
	createLocalImportFn: vi.fn(),
	localImportStatusFn: vi.fn(),
	cancelLocalImportFn: vi.fn(),
}));

import { FirstRun } from "./first-run";

function render(state: { githubConnected: boolean; modelReady: boolean }) {
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<FirstRun state={state} />
		</QueryClientProvider>,
	);
}

it("opens at GitHub, and asks for no repository once GitHub is connected", () => {
	const fresh = render({ githubConnected: false, modelReady: false });
	expect(fresh).toContain("Connect GitHub");
	expect(fresh).toContain('aria-current="step">GitHub');
	expect(fresh).toContain("Install the ytimesy app");
	expect(fresh).toContain("After sign-in");
	expect(fresh).not.toContain("Repositories");
	// Signed in, the app's repositories still loading: the GitHub step waits.
	const connected = render({ githubConnected: true, modelReady: false });
	expect(connected).toContain("Checking…");
	expect(connected).not.toContain("Choose repositories");
	expect(connected).not.toContain("add-project");
});

it("shows three stages: GitHub, Model, Sessions", () => {
	const html = render({ githubConnected: false, modelReady: false });
	const stages = [
		...html.matchAll(/<li[^>]*>(GitHub|Model|Sessions|Repositories)<\/li>/g),
	].map((match) => match[1]);
	expect(stages).toEqual(["GitHub", "Model", "Sessions"]);
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

it("offers SuperGrok only while its feature switch is on", () => {
	const off = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} />
		</QueryClientProvider>,
	);
	expect(off).not.toContain("SuperGrok");
	expect(off).not.toContain("Sign in with xAI");
	const on = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} xaiSubscription />
		</QueryClientProvider>,
	);
	expect(on).toContain("Your SuperGrok subscription");
	expect(on).toContain("Sign in with xAI");
	expect(on).toContain('data-count="3"');
});

import { SessionsStep } from "./first-run";

it("offers the agent-session import as an optional last step that never blocks", () => {
	const html = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<SessionsStep />
		</QueryClientProvider>,
	);
	expect(html).toContain("Copy prompt");
	expect(html).toContain('aria-label="Supported agents"');
	expect(html).toContain("Continue");
	expect(html).not.toMatch(/<button[^>]*disabled[^>]*>Continue/);
});
