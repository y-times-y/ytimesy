import { createFileRoute } from "@tanstack/react-router";
import privacy from "#/content/legal/privacy.md?raw";
import { PRIVACY_VERSION } from "#/content/legal/versions";
import { PrivacyChoices } from "../features/analytics/replay-choice-setting";
import { LegalPage } from "../features/legal/legal-page";

export const Route = createFileRoute("/privacy")({
	head: () => ({ meta: [{ title: "Privacy Policy · ytimesy" }] }),
	component: () => (
		<LegalPage
			markdown={privacy}
			version={PRIVACY_VERSION}
			before={<PrivacyChoices />}
		/>
	),
});
