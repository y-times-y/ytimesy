import type { SubagentBudget, SubagentRole } from "./subagent";

/**
 * How the chat shows its agents, everywhere: the agents list, the start and
 * finish lines, the helper view, and the agent tool's result and report
 * header the lead reads. The root agent is "Main"; a helper goes by its
 * task (the title the lead gave it), with a plain tag for its kind. Each
 * kind has an icon and a colour token; several of one kind keep the hue, a
 * shade lighter per extra instance. Internal role ids are unchanged.
 */

export const MAIN_NAME = "Main";

export type HelperKind = "sidekick" | SubagentRole;
export type AgentKind = "main" | HelperKind | "background";

/** The kind tag after a helper's name; Main has none. */
export const KIND_TAGS: Record<AgentKind, string | null> = {
	main: null,
	sidekick: "Build",
	writer: "Build",
	researcher: "Research",
	reviewer: "Review",
	checker: "Verify",
	background: "Background",
};

/** Lucide icon per kind (drawn in agent-icon.tsx). */
export type AgentIcon =
	| "bot"
	| "hammer"
	| "search"
	| "eye"
	| "circle-check"
	| "terminal";
export const KIND_ICONS: Record<AgentKind, AgentIcon> = {
	main: "bot",
	sidekick: "hammer",
	writer: "hammer",
	researcher: "search",
	reviewer: "eye",
	checker: "circle-check",
	background: "terminal",
};

/**
 * Colour per kind, as CSS custom properties on :root (styles.css). The
 * sidekick is a Build agent working in Main's checkout: blue, apart from
 * fork builders' copper. Colour goes on icons and accents only; text stays
 * neutral.
 */
export const KIND_COLOR_TOKENS: Record<AgentKind, string> = {
	main: "--agent-main",
	sidekick: "--agent-sidekick",
	writer: "--agent-build",
	researcher: "--agent-research",
	reviewer: "--agent-review",
	checker: "--agent-verify",
	background: "--agent-background",
};
export const KIND_COLORS: Record<AgentKind, string> = {
	main: "#E5E5E5",
	sidekick: "#7AA2F7",
	writer: "#D9A066",
	researcher: "#5FB3B3",
	reviewer: "#B48EF0",
	checker: "#7FC08A",
	background: "#8A8F98",
};

/** How much lighter the nth agent of a kind is (0 for the first, 12% per extra, at most 36%). */
export function kindShade(instance: number) {
	return Math.min(0.36, Math.max(0, instance) * 0.12);
}

/** A colour value for CSS: the kind's token, lightened for later instances. */
export function agentColor(kind: AgentKind, shade = 0) {
	const token = `var(${KIND_COLOR_TOKENS[kind]})`;
	return shade > 0
		? `color-mix(in oklab, ${token}, white ${Math.round(shade * 100)}%)`
		: token;
}

/** Lead mode fusion's sidekick is a writer whose budget carries its sidekick state. */
export function helperKind(helper: {
	readonly subagent?: {
		readonly role: SubagentRole;
		readonly budget: SubagentBudget | null;
	};
}): HelperKind {
	if (helper.subagent?.budget?.sidekick) return "sidekick";
	return helper.subagent?.role ?? "writer";
}

export function helperKindOf(
	role: SubagentRole,
	budget: SubagentBudget | null | undefined,
): HelperKind {
	return budget?.sidekick ? "sidekick" : role;
}

const NAME_MAX = 36;

/** A helper's name: its task title, cut cleanly at a word. */
export function helperName(title: string) {
	const words = title.replace(/\s+/g, " ").trim();
	if (!words) return "Untitled task";
	if (words.length <= NAME_MAX) return words;
	const cut = words.slice(0, NAME_MAX - 1);
	const space = cut.lastIndexOf(" ");
	return `${(space > 12 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
}

/** How the lead names a helper to the user: its task, then its kind. */
export function helperReference(title: string, kind: HelperKind) {
	return `${helperName(title)} (${KIND_TAGS[kind]})`;
}

export type HelperIdentity = {
	readonly name: string;
	readonly kind: HelperKind;
	readonly tag: string;
	readonly icon: AgentIcon;
	/** Its CSS colour (agentColor). */
	readonly color: string;
};

/** Every helper of one chat (any depth), in start order: name, tag, icon, colour. */
export function helperIdentitiesOf(
	helpers: readonly {
		readonly id: string;
		readonly createdAt: string;
		readonly kind: HelperKind;
		readonly title: string;
	}[],
) {
	const ordered = [...helpers].sort(
		(left, right) =>
			left.createdAt.localeCompare(right.createdAt) ||
			left.id.localeCompare(right.id),
	);
	const seen = new Map<HelperKind, number>();
	const identities = new Map<string, HelperIdentity>();
	for (const helper of ordered) {
		const instance = seen.get(helper.kind) ?? 0;
		seen.set(helper.kind, instance + 1);
		identities.set(helper.id, {
			name: helperName(helper.title),
			kind: helper.kind,
			tag: KIND_TAGS[helper.kind] as string,
			icon: KIND_ICONS[helper.kind],
			color: agentColor(helper.kind, kindShade(instance)),
		});
	}
	return identities;
}
