import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { AgentConnection } from "#/domain/agent-connection";
import { HarnessLogin } from "./harness-login";

function render(connection: AgentConnection, busy = false) {
	return renderToStaticMarkup(
		createElement(HarnessLogin, {
			harnessId: "codex",
			connection,
			busy,
			onConnect: () => {},
		}),
	);
}

it("asks an expired Codex login to sign in again without implying lost work", () => {
	const html = render({
		status: "expired",
		provider: "codex",
		message: "Reconnect Codex.",
	});
	expect(html).toContain("Codex sign-in expired");
	expect(html).toContain("Your chats and work are kept.");
	expect(html).toContain(">Sign in again</button>");
	expect(
		render({ status: "expired", provider: "codex", message: "" }, true),
	).toContain("disabled");
});

it("shows the device code with an external OpenAI link while authorizing", () => {
	const html = render({
		status: "awaiting_device_code",
		provider: "codex",
		loginId: "login",
		verificationUrl: "https://auth.openai.com/codex/device",
		userCode: "QK7M-4HTP",
	});
	expect(html).toContain("Sign in to Codex");
	expect(html).toContain('<code class="harness-login-code">QK7M-4HTP</code>');
	expect(html).toContain('href="https://auth.openai.com/codex/device"');
	expect(html).toContain('target="_blank"');
});

it("renders nothing once Codex is connected", () => {
	expect(
		render({
			status: "authenticated",
			provider: "codex",
			authMode: "chatgpt",
			planType: "free",
			email: null,
		}),
	).toBe("");
});

it("shows the sign-in card above the composer for an expired or pending login, not when ready", async () => {
	const { ComposerSignIn } = await import("./harness-login");
	const card = (connection: AgentConnection, harnessReady = false) =>
		renderToStaticMarkup(
			createElement(ComposerSignIn, {
				harnessReady,
				harnessId: "codex",
				connection,
				busy: false,
				onConnect: () => {},
			}),
		);
	expect(
		card({ status: "expired", provider: "codex", message: "Reconnect." }),
	).toContain("Codex sign-in expired");
	expect(
		card({
			status: "awaiting_device_code",
			provider: "codex",
			loginId: "login",
			verificationUrl: "https://auth.openai.com/codex/device",
			userCode: "QK7M-4HTP",
		}),
	).toContain("QK7M-4HTP");
	expect(
		card(
			{
				status: "authenticated",
				provider: "codex",
				authMode: "chatgpt",
				planType: null,
				email: null,
			},
			true,
		),
	).toBe("");
});

it("titles a failure that is not a sign-in problem neutrally", () => {
	const html = render({
		status: "failed",
		provider: "codex",
		message: "Prepare a project environment before starting an agent.",
	});
	expect(html).toContain("Couldn&#x27;t start the chat");
	expect(html).not.toContain("sign-in failed");
	expect(
		render({
			status: "failed",
			provider: "codex",
			message: "ChatGPT sign-in was not approved. Sign in again.",
		}),
	).toContain("Codex sign-in failed");
});
