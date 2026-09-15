export const RIGKIT_NODE_GAP =
	"@rigkit/sdk 0.3.0 targets a Bun project daemon and pulls @effect/platform-bun; ytimesy workers run on Node and prepare workspaces with Freestyle clone-and-install until Rigkit can run as a Node worker.";

export type WorkspacePreparationBackend =
	| {
			readonly method: "clone-and-install";
			readonly host: "freestyle";
	  }
	| {
			readonly method: "rigkit";
			readonly host: "freestyle";
			readonly available: false;
			readonly reason: string;
	  };

export function selectedWorkspacePreparation(): WorkspacePreparationBackend {
	return { method: "clone-and-install", host: "freestyle" };
}

export function rigkitPreparationStatus(): Extract<
	WorkspacePreparationBackend,
	{ method: "rigkit" }
> {
	return {
		method: "rigkit",
		host: "freestyle",
		available: false,
		reason: RIGKIT_NODE_GAP,
	};
}
