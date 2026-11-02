import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { composerSendBlock } from "#/domain/send-blocked";
import { SendBlockNotice } from "./send-block-notice";

const github = composerSendBlock({
	harnessId: "api",
	blockers: ["github"],
	modelId: "api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5",
	availableModelIds: [
		"api/3f1c2a4e-8b7d-4c1e-9f0a-1b2c3d4e5f60/openai%2Fgpt-5",
	],
});

it("says why the send did not go, with the fix", () => {
	if (!github) throw new Error("expected a block");
	const html = renderToStaticMarkup(
		<SendBlockNotice block={github} onFix={() => {}} />,
	);
	expect(html).toContain('role="alert"');
	expect(html).toContain("Connect GitHub to send.");
	expect(html).toContain(">Connect GitHub</button>");
});

it("keeps the reason without a fix it cannot open", () => {
	if (!github) throw new Error("expected a block");
	const html = renderToStaticMarkup(<SendBlockNotice block={github} />);
	expect(html).toContain("Connect GitHub to send.");
	expect(html).not.toContain("<button");
});
