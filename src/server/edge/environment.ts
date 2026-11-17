import type { AuthEmailBinding } from "../adapters/email";
import type { registerMemoryEmbeddings } from "../adapters/memory-embeddings";
import type { ArtifactsNamespace } from "../adapters/memory-repos";
import type { BackgroundJobRunner } from "./background-jobs";
import type { ModelConversation } from "./executor";
import type { ProjectEnvironment } from "./project-environment";
import type { UserHub } from "./user-hub";
import type { YSquaredCrew } from "./y-squared-crew";

export interface EdgeExecutorEnvironment {
	CODEX_EGRESS: Fetcher;
	HYPERDRIVE: Hyperdrive;
	MODEL_CONVERSATIONS: DurableObjectNamespace<ModelConversation>;
	PROJECT_ENVIRONMENTS: DurableObjectNamespace<ProjectEnvironment>;
	BACKGROUND_JOBS: DurableObjectNamespace<BackgroundJobRunner>;
	/** Each user's push hub (turn status of their chats), by user id. */
	USER_HUBS: DurableObjectNamespace<UserHub>;
	/** Each Y project's crew (thread status for Y² and its wakes), by project id. */
	Y_SQUARED_CREWS: DurableObjectNamespace<YSquaredCrew>;
	ENVIRONMENT_EXECUTION_ENABLED?: string;
	/** Turn runner boxes' thin-client API (docs/turn-runner-boxes.md); off unless users are named. */
	YTIMESY_BOX_TURN_USERS?: string;
	/** Ed25519 keys (base64) that sign box identities and per-turn grants; the box holds only the public one. */
	TURN_BOX_EDGE_PRIVATE_KEY?: string;
	TURN_BOX_EDGE_PUBLIC_KEY?: string;
	/** Per-user memory repos (Cloudflare Artifacts). */
	ARTIFACTS?: ArtifactsNamespace;
	/** Workers AI, for memory line embeddings. */
	AI?: Parameters<typeof registerMemoryEmbeddings>[0];
	/** Cloudflare Email Service; sends auth email without an API token. */
	EMAIL?: AuthEmailBinding;
}
