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
