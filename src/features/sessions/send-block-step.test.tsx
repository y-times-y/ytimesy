import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { composerSendBlock } from "#/domain/send-blocked";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => ({}),
}));
vi.mock("../auth/client", () => ({
	authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("../onboarding/setup-state.fn", () => ({ getSetupState: vi.fn() }));
vi.mock("../onboarding/first-run", () => ({
	GithubStep: () => <div>GITHUB STEP</div>,
	ModelStep: () => <div>MODEL STEP</div>,
}));
vi.mock("../projects/api", () => ({ requestJson: vi.fn() }));

import { SendBlockStep } from "./send-block-step";

const render = (block: NonNullable<ReturnType<typeof composerSendBlock>>) =>
	renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<SendBlockStep block={block} onFix={() => {}} />
		</QueryClientProvider>,
	);

const noModel = composerSendBlock({
	harnessId: "api",
	blockers: ["no_model"],
	modelId: "",
	availableModelIds: [],
});
const github = composerSendBlock({
	harnessId: "api",
	blockers: ["github"],
	modelId: "api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5",
	availableModelIds: [
		"api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5",
	],
});
const claude = composerSendBlock({
	harnessId: "api",
	blockers: ["no_model", "claude_token"],
	modelId: "",
	availableModelIds: [],
});

it("opens the model step in place, keeping the message, instead of a line pointing at Settings", () => {
	if (!noModel) throw new Error("expected a block");
	const html = render(noModel);
	expect(html).toContain("Choose a model to send");
	expect(html).toContain("Your message is saved");
	expect(html).toContain("MODEL STEP");
	expect(html).not.toContain("Open Settings");
	expect(html).not.toContain('role="alert"');
});

it("opens the GitHub step in place", () => {
	if (!github) throw new Error("expected a block");
	const html = render(github);
	expect(html).toContain("Connect GitHub to send");
	expect(html).toContain("GITHUB STEP");
});

it("keeps the plain notice for reasons with no in-place step", () => {
	if (!claude) throw new Error("expected a block");
	const html = render(claude);
	expect(html).toContain('role="alert"');
	expect(html).toContain("Claude subscription needs a new token.");
});
