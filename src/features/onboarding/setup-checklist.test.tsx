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

vi.mock("./setup-state.fn", () => ({ getSetupState: vi.fn() }));
vi.mock("../auth/client", () => ({
	authClient: { useSession: () => ({ data: null }) },
}));

import { setupProgress } from "#/domain/setup-steps";
import { SetupChecklistView } from "./setup-checklist";

function render(options: {
	githubConnected?: boolean;
	modelReady?: boolean;
	repositoryCount?: number | null;
	sessionsSkipped?: boolean;
	open?: "github" | "model" | "sessions" | null;
}) {
	const state = {
		githubConnected: options.githubConnected ?? false,
		modelReady: options.modelReady ?? false,
	};
	const progress = setupProgress({
		state,
		repositoryCount: options.repositoryCount ?? null,
		sessionsSkipped: options.sessionsSkipped ?? false,
	});
	return renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<SetupChecklistView
				progress={progress}
				state={state}
				installationUrl="https://github.com/apps/ytimesy/installations/new"
				repositoriesLoading={false}
				open={options.open ?? null}
				onToggle={() => {}}
				onHide={() => {}}
				onModelDone={() => {}}
				onSessionsDone={() => {}}
			/>
		</QueryClientProvider>,
	);
}

it("starts with three plain numbered steps and the way to hide it", () => {
	const html = render({});
	expect(html).toContain("Get set up");
	for (const title of [
		"Connect GitHub",
		"Choose a model",
		"Bring your agent sessions",
	])
		expect(html).toContain(title);
	expect(html).toContain("Optional");
	expect(html).toContain(">Hide<");
	expect(html).toContain('aria-valuenow="0"');
	expect(html).toContain('aria-valuemax="3"');
	// Circles carry the step number; nothing says "0 of 3".
	expect(html).toMatch(/>1<\/span>/);
	expect(html).toMatch(/>2<\/span>/);
	expect(html).toMatch(/>3<\/span>/);
	expect(html).not.toContain("0 of 3");
	expect(html).toContain(">Connect<");
	expect(html).toContain(">Choose<");
	expect(html).toContain(">Import<");
});

it("shows finished steps as checked and counts what is left", () => {
	const html = render({
		githubConnected: true,
		repositoryCount: 2,
		modelReady: true,
	});
	expect(html).toContain('aria-valuenow="2"');
	expect(html).toContain("1 to go.");
	expect(html).toContain("Connected");
	expect(html).toContain("Ready");
	expect(html).not.toContain(">Connect<");
	expect(html).toContain(">Import<");
});

it("signing in to GitHub alone leaves the step open until the app is installed", () => {
	const html = render({ githubConnected: true, repositoryCount: 0 });
	expect(html).toContain('aria-valuenow="0"');
	expect(html).toContain(">Connect<");
});

it("opens a step in place", () => {
	const html = render({
		githubConnected: true,
		repositoryCount: 1,
		open: "model",
	});
	expect(html).toContain("Sign in with ChatGPT");
	expect(html).toContain('aria-expanded="true"');
});

it("keeps a skipped import out of the way", () => {
	const html = render({
		githubConnected: true,
		repositoryCount: 1,
		modelReady: true,
		sessionsSkipped: true,
	});
	expect(html).toContain('aria-valuenow="3"');
});
