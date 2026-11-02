import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => ({}),
}));
vi.mock("../auth/legal-acceptance.fn", () => ({
	getLegalAcceptanceFn: vi.fn(),
	acceptLegalTermsFn: vi.fn(),
}));
vi.mock("../workspace/training-consent.fn", () => ({
	saveTrainingConsentFn: vi.fn(),
	readTrainingPromptFn: vi.fn(),
	dismissTrainingPromptFn: vi.fn(),
}));
vi.mock("../sessions/chatgpt-sign-in", () => ({
	ChatgptSignIn: () => <button type="button">Sign in with ChatGPT</button>,
}));
vi.mock("../sessions/xai-subscription-sign-in", () => ({
	XaiSubscriptionSignIn: () => <button type="button">Sign in with xAI</button>,
}));
vi.mock("../sessions/claude-subscription.fn", () => ({
	getClaudeSubscription: vi.fn(),
	saveClaudeSubscriptionFn: vi.fn(),
	disconnectClaudeSubscriptionFn: vi.fn(),
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

it("shows four stages: GitHub, Model, Sessions, Privacy", () => {
	const html = render({ githubConnected: false, modelReady: false });
	const stages = [
		...html.matchAll(
			/<li[^>]*>(GitHub|Model|Sessions|Privacy|Repositories)<\/li>/g,
		),
	].map((match) => match[1]);
	expect(stages).toEqual(["GitHub", "Model", "Sessions", "Privacy"]);
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

it("offers the Grok subscription only while its feature switch is on", () => {
	const off = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} />
		</QueryClientProvider>,
	);
	expect(off).not.toContain("Grok subscription");
	expect(off).not.toContain("Sign in with xAI");
	const on = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} xaiSubscription />
		</QueryClientProvider>,
	);
	expect(on).toContain("Your Grok subscription");
	expect(on).toContain("Sign in with xAI");
	expect(on).toContain('data-count="3"');
});

it("offers the Claude plan, with its setup token, only while its feature switch is on", () => {
	const off = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} />
		</QueryClientProvider>,
	);
	expect(off).not.toContain("Claude subscription");
	expect(off).not.toContain("setup-token");
	const on = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} claudeSubscription />
		</QueryClientProvider>,
	);
	expect(on).toContain("Your Claude subscription");
	expect(on).toContain("Paste setup token");
	expect(on).toContain("<code>claude setup-token</code>");
	expect(on).toContain('data-count="3"');
	// Each plan wears its subscription mark, as in the model picker.
	expect(on).toContain('data-brand="codex"');
	expect(on).toContain('data-brand="claude"');
	// Both plans on: four cards, two by two.
	const both = renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<ModelStep ready={false} claudeSubscription xaiSubscription />
		</QueryClientProvider>,
	);
	expect(both).toContain('data-count="4"');
	const order = ["Codex", "Claude", "Grok", "API key"].map((name) =>
		both.indexOf(`Your ${name}`),
	);
	expect(order).toEqual([...order].sort((a, b) => a - b));
});

it("shows the Claude plan as connected once its token works", () => {
	const client = new QueryClient();
	client.setQueryData(["claude-subscription"], {
		enabled: true,
		status: "connected",
		limitedUntil: null,
		models: [],
	});
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<ModelStep ready claudeSubscription />
		</QueryClientProvider>,
	);
	expect(html).toContain("Connected");
	expect(html).not.toContain("Paste setup token");
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
