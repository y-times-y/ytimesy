export type SlashCommandId =
	| "stop"
	| "retry"
	| "model"
	| "files"
	| "diff"
	| "terminal"
	| "desktop"
	| "custom";

export type SlashCommandAvailability = "ready" | "unavailable";

export type SlashCommand = {
	readonly id: SlashCommandId;
	readonly trigger: string;
	readonly label: string;
	readonly description: string;
	readonly availability: SlashCommandAvailability;
	readonly unavailableReason?: string;
	/** Prompt template for a repository-defined command (id "custom"). */
	readonly template?: string;
	readonly argumentHint?: string;
};

/** Repository commands live in .claude/commands or .agents/commands as <name>.md. */
const PROJECT_COMMAND_PATH =
	/^(?:\.claude|\.agents)\/commands\/([a-z0-9][a-z0-9_-]{0,47})\.md$/;
const BUILT_IN_TRIGGERS = new Set([
	"stop",
	"retry",
	"model",
	"files",
	"diff",
	"terminal",
	"desktop",
]);

/** Parses optional `description` / `argument-hint` frontmatter; the rest is the template. */
export function projectCommandFromFile(
	path: string,
	text: string,
): SlashCommand | null {
	const name = PROJECT_COMMAND_PATH.exec(path)?.[1];
	if (!name || BUILT_IN_TRIGGERS.has(name)) return null;
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
	const fields = new Map<string, string>();
	for (const line of frontmatter?.[1].split(/\r?\n/) ?? []) {
		const field = /^([a-z-]+):\s*(.*)$/.exec(line.trim());
		if (field) fields.set(field[1], field[2].replace(/^["']|["']$/g, ""));
	}
	const template = (
		frontmatter ? text.slice(frontmatter[0].length) : text
	).trim();
	if (!template) return null;
	return {
		id: "custom",
		trigger: `/${name}`,
		label: name,
		description:
			fields.get("description")?.slice(0, 200) ||
			template.split("\n")[0].slice(0, 120),
		availability: "ready",
		template,
		argumentHint: fields.get("argument-hint")?.slice(0, 80),
	};
}

/** $ARGUMENTS takes the whole argument, $1..$9 its words; otherwise it is appended. */
export function expandProjectCommand(template: string, argument: string) {
	const words = argument.split(/\s+/).filter(Boolean);
	if (!/\$ARGUMENTS|\$[1-9]/.test(template))
		return argument ? `${template}\n\n${argument}` : template;
	return template
		.replaceAll("$ARGUMENTS", argument)
		.replace(/\$([1-9])/g, (_match, index) => words[Number(index) - 1] ?? "");
}

type SlashDraft = {
	readonly query: string;
	readonly argument: string;
};

type SlashCommandContext = {
	readonly authenticated: boolean;
	readonly requiresAccountLogin: boolean;
	readonly turnRunning: boolean;
	readonly canSend: boolean;
	readonly hasLastUserMessage: boolean;
	readonly hasModels: boolean;
};

export function parseSlashDraft(draft: string): SlashDraft | null {
	if (!draft.startsWith("/") || draft.includes("\n")) return null;
	const body = draft.slice(1);
	const space = body.search(/\s/);
	if (space === -1) return { query: body.toLowerCase(), argument: "" };
	return {
		query: body.slice(0, space).toLowerCase(),
		argument: body.slice(space).trim(),
	};
}

export function composerSlashCommands(
	context: SlashCommandContext,
): readonly SlashCommand[] {
	const startHint = context.requiresAccountLogin
		? "Sign in to an agent"
		: "Connect an agent";
	return [
		{
			id: "stop",
			trigger: "/stop",
			label: "Stop",
			description: "Cancel the run you are viewing",
			availability: context.turnRunning ? "ready" : "unavailable",
			unavailableReason: "No run is in progress",
		},
		{
			id: "retry",
			trigger: "/retry",
			label: "Retry",
			description: "Send the last task again",
			availability:
				context.canSend && context.hasLastUserMessage ? "ready" : "unavailable",
			unavailableReason: context.turnRunning
				? "Wait for the current run to finish"
				: "Nothing to retry yet",
		},
		{
			id: "model",
			trigger: "/model",
			label: "Model",
			description: "Switch the model for the next run",
			availability: context.hasModels ? "ready" : "unavailable",
			unavailableReason: `${startHint} to load models`,
		},
		{
			id: "files",
			trigger: "/files",
			label: "Files",
			description: "Show the workspace file tree",
			availability: "ready",
		},
		{
			id: "diff",
			trigger: "/diff",
			label: "Diff",
			description: "Show file changes",
			availability: "ready",
		},
		{
			id: "terminal",
			trigger: "/terminal",
			label: "Terminal",
			description: "Show the workspace terminal",
			availability: "ready",
		},
		{
			id: "desktop",
			trigger: "/desktop",
			label: "Desktop",
			description: "Show the shared workspace desktop",
			availability: "ready",
		},
	];
}

function slashCommandMatches(command: SlashCommand, query: string): boolean {
	if (query.length === 0) return true;
	if (command.trigger.slice(1).startsWith(query)) return true;
	if (command.id.startsWith(query)) return true;
	return command.label
		.toLowerCase()
		.split(/\s+/)
		.some((word) => word.startsWith(query));
}

export function matchingSlashCommands(
	draft: SlashDraft,
	commands: readonly SlashCommand[],
): SlashCommand[] {
	const matched = commands.filter((command) =>
		slashCommandMatches(command, draft.query),
	);
	if (draft.query.length === 0) {
		const ready = matched.filter((command) => command.availability === "ready");
		if (ready.length > 0) return ready;
	}
	return matched.sort((left, right) => {
		if (left.availability === right.availability) return 0;
		return left.availability === "ready" ? -1 : 1;
	});
}

/**
 * The command a draft names exactly, if any. Only project commands take an
 * argument; "/files are missing" or "/api/x returns 500" are messages.
 */
export function exactSlashCommand(
	draft: SlashDraft,
	commands: readonly SlashCommand[],
): SlashCommand | null {
	const command = commands.find(
		(candidate) => candidate.trigger.slice(1).toLowerCase() === draft.query,
	);
	if (!command) return null;
	if (draft.argument && command.id !== "custom") return null;
	return command;
}

/** Menu entries while the user is still typing a command; none once it reads as a message. */
export function slashMenuCommands(
	draft: SlashDraft,
	commands: readonly SlashCommand[],
): SlashCommand[] {
	if (!draft.argument) return matchingSlashCommands(draft, commands);
	const exact = exactSlashCommand(draft, commands);
	return exact ? [exact] : [];
}
