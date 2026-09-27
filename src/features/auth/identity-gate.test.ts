import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { IdentityGate } from "./identity-gate";

const state = vi.hoisted(() => ({
	isPending: true,
	data: null as null | object,
}));
vi.mock("./client", () => ({ authClient: { useSession: () => state } }));
vi.mock("./onboarding-shell", () => ({
	OnboardingShell: ({ children }: { children: unknown }) => children,
}));
vi.mock("#/components/auth/auth", () => ({ Auth: () => "Sign in" }));

describe("server-verified identity", () => {
	it("keeps the workspace visible during the browser session check", () => {
		state.isPending = true;
		const html = renderToStaticMarkup(
			createElement(IdentityGate, {
				initialSignedIn: true,
				children: "Workspace",
			}),
		);
		expect(html).toBe("Workspace");
	});
	it("never renders a workspace for an unverified pending session", () => {
		state.isPending = true;
		expect(
			renderToStaticMarkup(
				createElement(IdentityGate, {
					initialSignedIn: false,
					children: "Workspace",
				}),
			),
		).toBe("");
	});
	it("honors a resolved logout even after a signed-in server render", () => {
		state.isPending = false;
		state.data = null;
		expect(
			renderToStaticMarkup(
				createElement(IdentityGate, {
					initialSignedIn: true,
					children: "Workspace",
				}),
			),
		).toBe("Sign in");
	});
});
