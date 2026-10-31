import { HELPER_COLORS, KIND_ICONS } from "#/domain/helper-names";

/**
 * What the front page's preview shows: the dark mode chat's full turn, drawn
 * by the product's own components, and the other chats' opening messages.
 * Plain data; nothing runs.
 */

export const DEMO_AGENTS = [
	{
		name: "build-1",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[2],
		task: "Theme tokens and the toggle",
		done: true,
	},
	{
		name: "build-2",
		icon: KIND_ICONS.writer,
		color: HELPER_COLORS[0],
		task: "Settings page",
		done: true,
	},
	{
		name: "verify-1",
		icon: KIND_ICONS.checker,
		color: HELPER_COLORS[4],
		task: "Check it in the browser",
		done: false,
	},
] as const;

export type DemoAgent = (typeof DEMO_AGENTS)[number];

/** The one edit the preview opens by default; its colours are precomputed. */
export const DEMO_EDIT = {
	path: "src/settings/appearance.tsx",
	hunks: [
		{
			removed: 'import { Section } from "./section";',
			added: 'import { Section, Toggle } from "./section";',
		},
		{
			removed: '\treturn <Section title="Appearance" />;',
			added: [
				"\tconst darkMode = useDarkMode();",
				"\treturn (",
				'\t\t<Section title="Appearance">',
				'\t\t\t<Toggle label="Dark mode" {...darkMode} />',
				"\t\t</Section>",
				"\t);",
			].join("\n"),
		},
	],
} as const;

export type DemoItem =
	| { kind: "user"; text: string }
	| { kind: "text"; text: string }
	| { kind: "explored"; files: readonly string[] }
	| { kind: "agent"; agent: DemoAgent }
	| { kind: "edit" }
	| { kind: "ran"; command: string; output: string; failed?: boolean }
	| { kind: "memory"; text: string };

export type DemoTodo = {
	text: string;
	status: "completed" | "in_progress" | "pending";
};

export type DemoChat = {
	id: string;
	title: string;
	project: "web" | "api";
	status: "asking" | "working" | "open" | "merged" | "failed" | "unread";
	age?: string;
	pr?: { number: number; branch: string; state: string };
	todos?: readonly DemoTodo[];
	agents?: boolean;
	turn: readonly DemoItem[];
};

export const DEMO_CHATS: readonly DemoChat[] = [
	{
		id: "chart",
		title: "Pick a chart library",
		project: "web",
		status: "asking",
		turn: [{ kind: "user", text: "Add charts to the usage dashboard." }],
	},
	{
		id: "dark",
		title: "Add dark mode",
		project: "web",
		status: "working",
		age: "now",
		pr: { number: 128, branch: "ytimesy/dark-mode", state: "Ready to merge" },
		agents: true,
		todos: [
			{ text: "Theme tokens", status: "completed" },
			{ text: "Settings toggle", status: "completed" },
			{ text: "Check it in the browser", status: "in_progress" },
			{ text: "Open the pull request", status: "pending" },
		],
		turn: [
			{
				kind: "user",
				text: "Add a dark mode toggle to settings. Keep the brand colors.",
			},
			{
				kind: "text",
				text: "Splitting this across three agents, each in its own machine.",
			},
			{
				kind: "explored",
				files: [
					"src/settings/appearance.tsx",
					"src/settings/section.tsx",
					"src/styles/theme.ts",
					"src/styles/tokens.css",
					"src/app.tsx",
					"src/hooks/use-dark-mode.ts",
					"tailwind.config.ts",
					"src/settings/appearance.test.tsx",
					"package.json",
				],
			},
			...DEMO_AGENTS.map((agent) => ({ kind: "agent" as const, agent })),
			{ kind: "edit" },
			{
				kind: "ran",
				command: "pnpm test",
				output: [
					" ✓ src/settings/appearance.test.tsx (3 tests)",
					" ✓ src/styles/theme.test.ts (5 tests)",
					"",
					" Test Files  42 passed (42)",
					"      Tests  318 passed (318)",
				].join("\n"),
			},
			{
				kind: "memory",
				text: "Colors come from src/styles/tokens.css; never hard-code them.",
			},
		],
	},
	{
		id: "search",
		title: "Speed up search",
		project: "api",
		status: "working",
		age: "2m",
		turn: [
			{
				kind: "user",
				text: "Search takes 2 seconds on big projects. Make it fast.",
			},
		],
	},
	{
		id: "login",
		title: "Fix login redirect",
		project: "web",
		status: "open",
		pr: {
			number: 127,
			branch: "ytimesy/login-redirect",
			state: "Checks passed",
		},
		turn: [
			{
				kind: "user",
				text: "After login you always land on the home page. Send people back where they were.",
			},
		],
	},
	{
		id: "router",
		title: "Upgrade the router",
		project: "api",
		status: "merged",
		pr: { number: 124, branch: "ytimesy/router-v7", state: "Merged" },
		turn: [{ kind: "user", text: "Upgrade the router to v7." }],
	},
	{
		id: "cache",
		title: "Cache API responses",
		project: "api",
		status: "failed",
		pr: { number: 126, branch: "ytimesy/api-cache", state: "1 check failing" },
		turn: [{ kind: "user", text: "Cache the list endpoints for 60 seconds." }],
	},
	{
		id: "emails",
		title: "Write onboarding emails",
		project: "web",
		status: "unread",
		turn: [{ kind: "user", text: "Draft the three onboarding emails." }],
	},
];
