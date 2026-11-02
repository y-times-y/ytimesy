/**
 * When a project's setup starts by itself: a project just added, whose
 * first environment build is under way and which has no chat yet. Adding a
 * project opens its setup chat at once (with the build streaming in it),
 * whichever form added it; nobody has to type anything.
 *
 * A project with a working environment (ready, or rebuilding with one), a
 * failed first build, or any chat never starts it again; neither does a
 * project this tab already started (the server also refuses a second start:
 * initialSetupMessageId).
 */
export function startsProjectSetup(input: {
	readonly projectId: string | undefined;
	readonly workspace:
		| {
				readonly projectId: string;
				readonly status: string;
				readonly build?: { readonly rebuild: boolean } | null;
		  }
		| null
		| undefined;
	/** The project's chats; undefined while they load. */
	readonly chats: readonly unknown[] | undefined;
	readonly startedInThisTab: ReadonlySet<string>;
}): boolean {
	const { projectId, workspace, chats } = input;
	if (!projectId || input.startedInThisTab.has(projectId)) return false;
	if (!workspace || workspace.projectId !== projectId) return false;
	if (!FIRST_BUILD_RUNNING.has(workspace.status)) return false;
	if (workspace.build?.rebuild) return false;
	return chats !== undefined && chats.length === 0;
}

const FIRST_BUILD_RUNNING = new Set([
	"queued",
	"provisioning",
	"cloning",
	"installing",
]);

/**
 * The setup chat can only start once its environment exists (the server
 * refuses a chat before that), so a tab that sees a new project's first build
 * running waits ("await"), then starts the setup agent when the build is
 * ready ("start"). A task the person sent during the build goes first and
 * takes the place of the setup chat: it runs in its own chat and opens a PR.
 */
export function projectSetupStep(input: {
	readonly projectId: string | undefined;
	readonly workspace: Parameters<typeof startsProjectSetup>[0]["workspace"];
	readonly chats: readonly unknown[] | undefined;
	readonly startedInThisTab: ReadonlySet<string>;
	/** Projects whose first build this tab saw running. */
	readonly awaitingInThisTab: ReadonlySet<string>;
	/** The person sent a task while the build ran. */
	readonly taskHeld: boolean;
}): "await" | "start" | null {
	const { projectId, workspace, chats } = input;
	if (!projectId || input.startedInThisTab.has(projectId)) return null;
	if (!workspace || workspace.projectId !== projectId) return null;
	if (chats === undefined || chats.length > 0 || input.taskHeld) return null;
	if (FIRST_BUILD_RUNNING.has(workspace.status) && !workspace.build?.rebuild)
		return input.awaitingInThisTab.has(projectId) ? null : "await";
	if (workspace.status === "ready" && input.awaitingInThisTab.has(projectId))
		return "start";
	return null;
}
