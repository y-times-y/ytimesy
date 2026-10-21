import { createFileRoute } from "@tanstack/react-router";
import terms from "#/content/legal/terms.md?raw";
import { TERMS_VERSION } from "#/content/legal/versions";
import { LegalPage } from "../features/legal/legal-page";

export const Route = createFileRoute("/terms")({
	head: () => ({ meta: [{ title: "Terms of Service · ytimesy" }] }),
	component: () => <LegalPage markdown={terms} version={TERMS_VERSION} />,
});
