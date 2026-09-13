import { Context, type Effect } from "effect";
import type { AgentConnection } from "#/domain/agent-connection";
import type { WorkspaceId } from "#/domain/ids";
import type { ProofWorkspace, WorkspaceMachines } from "./workspace-machines";

export type CodexProbeResult = {
	readonly connection: AgentConnection;
	readonly codexVersion: string | null;
	readonly notes: readonly string[];
};

export class WorkspaceMachineService extends Context.Tag(
	"ytimesy/WorkspaceMachineService",
)<WorkspaceMachineService, WorkspaceMachines>() {}

export class CodexAppServer extends Context.Tag("ytimesy/CodexAppServer")<
	CodexAppServer,
	{
		readonly installAndProbeDeviceCode: (
			workspaceId: WorkspaceId,
		) => Effect.Effect<CodexProbeResult>;
	}
>() {}

export type IsolatedWorkspaceProof = {
	readonly workspace: ProofWorkspace;
	readonly guest: {
		readonly uname: string;
		readonly python: string | null;
	};
	readonly agent: {
		readonly connection: AgentConnection;
		readonly codexVersion: string | null;
		readonly notes: readonly string[];
	};
};
