import type { BackgroundJob } from "../../domain/background-job";
import type { EnvironmentWorkflowRequest } from "../../domain/environment-workflow";
import type { WorkflowTurn } from "../../domain/model-workflow";
import type { ModelConversation } from "./executor";

export interface EdgeExecutorEnvironment {
	CODEX_EGRESS: Fetcher;
	HYPERDRIVE: Hyperdrive;
	MODEL_CONVERSATIONS: DurableObjectNamespace<ModelConversation>;
	PROJECT_ENVIRONMENTS: Workflow<EnvironmentWorkflowRequest>;
	MODEL_TURNS: Workflow<WorkflowTurn>;
	BACKGROUND_JOBS: Workflow<BackgroundJob>;
	ENVIRONMENT_EXECUTION_ENABLED?: string;
}
