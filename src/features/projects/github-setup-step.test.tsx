import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { GITHUB_SETUP_MESSAGE } from "#/domain/github-sign-in";

vi.mock("@tanstack/react-start", () => ({
	useServerFn: (fn: unknown) => fn,
	createServerFn: () => ({}),
}));
vi.mock("../auth/client", () => ({
	authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("../onboarding/setup-state.fn", () => ({ getSetupState: vi.fn() }));
vi.mock("../onboarding/setup-options", () => ({
	GithubOptions: () => <div>GITHUB STEP</div>,
}));
vi.mock("./api", () => ({ requestJson: vi.fn() }));

import { GithubSetupStep } from "./github-setup-step";

const render = (message: string) =>
	renderToStaticMarkup(
		<QueryClientProvider client={new QueryClient()}>
			<GithubSetupStep message={message} />
		</QueryClientProvider>,
	);

it("shows the message with the Connect step in place when GitHub is the problem", () => {
	const html = render(GITHUB_SETUP_MESSAGE);
	expect(html).toContain(GITHUB_SETUP_MESSAGE);
	expect(html).toContain("GITHUB STEP");
});

it("renders nothing for any other failure", () => {
	expect(render("Could not start environment setup.")).toBe("");
});
