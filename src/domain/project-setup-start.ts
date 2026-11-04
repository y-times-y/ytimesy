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
 * The setup agent starts from the build's report, so a tab that sees a new
 * project's first build running, with nothing sent, waits ("await"), then
 * opens the setup chat when the build is ready ("start"): the person is
 * looking at it. A task sent during the build never waits and never loses
 * its place: it runs at once in its own chat, and the server starts the
 * setup beside it, in the background (startProjectSetupBesideTask), so the
 * tab opens nothing.
 */
export function projectSetupStep(input: {
	readonly projectId: string | undefined;
	readonly workspace: Parameters<typeof startsProjectSetup>[0]["workspace"];
	readonly chats: readonly unknown[] | undefined;
	readonly startedInThisTab: ReadonlySet<string>;
	/** Projects whose first build this tab saw running. */
	readonly awaitingInThisTab: ReadonlySet<string>;
	/** The person sent a task in this project from this tab. */
	readonly taskSent: boolean;
}): "await" | "start" | null {
	const { projectId, workspace, chats } = input;
	if (!projectId || input.startedInThisTab.has(projectId)) return null;
	if (!workspace || workspace.projectId !== projectId) return null;
	if (chats === undefined || chats.length > 0 || input.taskSent) return null;
	if (FIRST_BUILD_RUNNING.has(workspace.status) && !workspace.build?.rebuild)
		return input.awaitingInThisTab.has(projectId) ? null : "await";
	if (workspace.status === "ready" && input.awaitingInThisTab.has(projectId))
		return "start";
	return null;
}

/**
 * A new project's first build is running and nothing has been sent: the empty
 * chat shows the setup streaming in place, where the person is looking.
 */
export function showsFirstSetupInChat(input: {
	readonly projectId: string | undefined;
	readonly workspace: Parameters<typeof startsProjectSetup>[0]["workspace"];
	readonly chats: readonly unknown[] | undefined;
	readonly chatOpen: boolean;
}) {
	const { projectId, workspace, chats } = input;
	return Boolean(
		projectId &&
			!input.chatOpen &&
			workspace &&
			workspace.projectId === projectId &&
			FIRST_BUILD_RUNNING.has(workspace.status) &&
			!workspace.build?.rebuild &&
			chats !== undefined &&
			chats.length === 0,
	);
}
