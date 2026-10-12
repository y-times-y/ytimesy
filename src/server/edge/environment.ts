import type { EnvironmentWorkflowRequest } from "../../domain/environment-workflow";
import type { WorkflowTurn } from "../../domain/model-workflow";
import type { BackgroundJobRunner } from "./background-jobs";
import type { ModelConversation } from "./executor";

export interface EdgeExecutorEnvironment {
	CODEX_EGRESS: Fetcher;
	HYPERDRIVE: Hyperdrive;
	MODEL_CONVERSATIONS: DurableObjectNamespace<ModelConversation>;
	PROJECT_ENVIRONMENTS: Workflow<EnvironmentWorkflowRequest>;
	MODEL_TURNS: Workflow<WorkflowTurn>;
	BACKGROUND_JOBS: DurableObjectNamespace<BackgroundJobRunner>;
	ENVIRONMENT_EXECUTION_ENABLED?: string;
}
