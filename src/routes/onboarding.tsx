import { createFileRoute } from "@tanstack/react-router";
import { ProjectOnboarding } from "../features/projects/project-onboarding";
export const Route = createFileRoute("/onboarding")({
	component: ProjectOnboarding,
});
