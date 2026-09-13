import { createFileRoute } from "@tanstack/react-router";
import { IdentityGate } from "../features/auth/identity-gate";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({
	component: () => (
		<IdentityGate>
			<WorkspaceHome />
		</IdentityGate>
	),
});
