import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceHome } from "../features/workspace/workspace-home";

export const Route = createFileRoute("/")({ component: WorkspaceHome });
