import type { AuthEmailBinding } from "../adapters/email";
import type { registerMemoryEmbeddings } from "../adapters/memory-embeddings";
import type { ArtifactsNamespace } from "../adapters/memory-repos";
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
	/** Per-user memory repos (Cloudflare Artifacts). */
	ARTIFACTS?: ArtifactsNamespace;
	/** Workers AI, for memory line embeddings. */
	AI?: Parameters<typeof registerMemoryEmbeddings>[0];
	/** Cloudflare Email Service; sends auth email without an API token. */
	EMAIL?: AuthEmailBinding;
}
