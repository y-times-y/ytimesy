import { createFileRoute } from "@tanstack/react-router";
import training from "#/content/legal/training-opt-in.md?raw";
import { TRAINING_POLICY_VERSION } from "#/content/legal/versions";
import { LegalPage, publicLegalMarkdown } from "../features/legal/legal-page";

/** The schema section is the product spec, not user-facing policy. */
const publicTraining = publicLegalMarkdown(
	training,
	"## Schema and product requirements",
);

export const Route = createFileRoute("/training")({
	head: () => ({ meta: [{ title: "Training Data Opt-In · ytimesy" }] }),
	component: () => (
		<LegalPage markdown={publicTraining} version={TRAINING_POLICY_VERSION} />
	),
});
