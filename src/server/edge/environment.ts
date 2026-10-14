import type { AuthEmailBinding } from "../adapters/email";
import type { BackgroundJobRunner } from "./background-jobs";
import type { ModelConversation } from "./executor";
import type { ProjectEnvironment } from "./project-environment";

export interface EdgeExecutorEnvironment {
	CODEX_EGRESS: Fetcher;
	HYPERDRIVE: Hyperdrive;
	MODEL_CONVERSATIONS: DurableObjectNamespace<ModelConversation>;
	PROJECT_ENVIRONMENTS: DurableObjectNamespace<ProjectEnvironment>;
	BACKGROUND_JOBS: DurableObjectNamespace<BackgroundJobRunner>;
	ENVIRONMENT_EXECUTION_ENABLED?: string;
	/** Cloudflare Email Service; sends auth email without an API token. */
	EMAIL?: AuthEmailBinding;
}
