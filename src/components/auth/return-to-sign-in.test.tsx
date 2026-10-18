import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
	redirectTo: "/",
	navigate: vi.fn(),
	signInSocial: vi.fn(),
	signInPopup: vi.fn(),
	socialSignInMode: "redirect" as "redirect" | "popup",
	click: undefined as undefined | (() => void),
}));
vi.mock("@better-auth-ui/react", () => ({
	useAuth: () => ({
		authClient: {},
		baseURL: "",
		basePaths: { auth: "/auth" },
		localization: { auth: { continueWith: "Continue with {{provider}}" } },
		navigate: auth.navigate,
		plugins: [],
		redirectTo: auth.redirectTo,
		socialSignInMode: auth.socialSignInMode,
	}),
	renderProviderIcon: () => null,
	useFetchOptions: () => ({ fetchOptions: {}, resetFetchOptions: vi.fn() }),
	useSignInSocial: () => ({ mutate: auth.signInSocial, isPending: false }),
	useSignInOAuthPopup: () => ({ mutate: auth.signInPopup, isPending: false }),
}));
vi.mock("@tanstack/react-query", () => ({ useIsMutating: () => 0 }));
vi.mock("#/components/ui/button.tsx", () => ({
	Button: (props: { onClick: () => void; children: unknown }) => {
		auth.click = props.onClick;
		return null;
	},
}));
vi.mock("./last-login-method/last-used-badge", () => ({
	LastUsedBadge: () => null,
}));

import { useSignInContinuation } from "#/lib/auth/use-sign-in-continuation";
import { ProviderButton } from "./provider-button";

const evidence =
	"/projects/0f8b6c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f/evidence/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

beforeEach(() => {
	vi.clearAllMocks();
	auth.redirectTo = evidence;
	auth.socialSignInMode = "redirect";
});

function clickProvider(provider: "github" | "google") {
	renderToStaticMarkup(<ProviderButton provider={provider} />);
	auth.click?.();
}

describe("sign-in returns to the deep link", () => {
	it.each(["github", "google"] as const)(
		"sends %s back to the page, and failures back to sign-in holding it",
		(provider) => {
			clickProvider(provider);
			expect(auth.signInSocial).toHaveBeenCalledWith(
				expect.objectContaining({
					provider,
					callbackURL: evidence,
					errorCallbackURL: `/auth/sign-in?redirectTo=${encodeURIComponent(evidence)}`,
				}),
			);
		},
	);

	it("never hands a provider an off-site return address", () => {
		for (const unsafe of [
			"https://evil.example",
			"//evil.example",
			"/\\evil",
		]) {
			auth.redirectTo = unsafe;
			clickProvider("github");
			expect(auth.signInSocial).toHaveBeenLastCalledWith(
				expect.objectContaining({
					callbackURL: "/",
					errorCallbackURL: "/auth/sign-in",
				}),
			);
		}
	});

	it("returns to the page after an email sign-in, and refuses an off-site one", () => {
		let continueSignIn: ((data: unknown) => void) | undefined;
		function Probe() {
			continueSignIn = useSignInContinuation();
			return null;
		}
		renderToStaticMarkup(<Probe />);
		continueSignIn?.({ token: "t" });
		expect(auth.navigate).toHaveBeenLastCalledWith({ to: evidence });

		auth.redirectTo = "https://evil.example";
		renderToStaticMarkup(<Probe />);
		continueSignIn?.({ token: "t" });
		expect(auth.navigate).toHaveBeenLastCalledWith({ to: "/" });
	});
});
