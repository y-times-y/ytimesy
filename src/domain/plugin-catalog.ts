/**
 * Our reviewed plugin marketplace. Only these plugins install officially, each
 * pinned to the exact commit that was reviewed; adding an entry is the review.
 * Anyone can request a plugin; developers can still have an agent use any
 * plugin inside its own VM, outside this catalog.
 */
export type PluginCatalogEntry = {
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	readonly owner: string;
	readonly repo: string;
	readonly sha: string;
	readonly path: string;
	/** The plugin's userConfig fields, copied at review so the UI can ask before installing. */
	readonly settings?: readonly {
		readonly key: string;
		readonly title: string;
		readonly description: string;
		readonly sensitive: boolean;
	}[];
};

// Reviewed 2026-10-11 from Anthropic's official marketplace (anthropics/claude-plugins-official@f359d43);
// each entry was fetched and parsed at this exact commit. Sign-in (OAuth) MCP servers install as
// skills/commands only until OAuth support lands.
export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
	{
		id: "github",
		displayName: "GitHub",
		description:
			"Official GitHub MCP server for repository management. Create issues, manage pull requests, review code, search repositories, and interact with GitHub's full\u2026",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/github",
		settings: [
			{
				key: "GITHUB_PERSONAL_ACCESS_TOKEN",
				title: "GITHUB_PERSONAL_ACCESS_TOKEN",
				description: "Required by the github MCP server",
				sensitive: true,
			},
		],
	},
	{
		id: "gitlab",
		displayName: "GitLab",
		description:
			"GitLab DevOps platform integration. Manage repositories, merge requests, CI/CD pipelines, issues, and wikis. Full access to GitLab's comprehensive DevOps\u2026",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/gitlab",
	},
	{
		id: "linear",
		displayName: "Linear",
		description:
			"Linear issue tracking integration. Create issues, manage projects, update statuses, search across workspaces, and streamline your software development\u2026",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/linear",
	},
	{
		id: "sentry",
		displayName: "Sentry",
		description:
			"Sentry error monitoring integration. Access error reports, analyze stack traces, search issues by fingerprint, and debug production errors directly from\u2026",
		owner: "getsentry",
		repo: "plugin-claude",
		sha: "73e53541d7af21672e27428c7067f4264b8a3d65",
		path: "",
	},
	{
		id: "notion",
		displayName: "Notion",
		description:
			"Notion workspace integration. Search pages, create and update documents, manage databases, and access your team's knowledge base directly from Claude Code\u2026",
		owner: "makenotion",
		repo: "claude-code-notion-plugin",
		sha: "9847f2aa1a15f25df35ed1fb7b4557dbb60cd651",
		path: "",
	},
	{
		id: "atlassian",
		displayName: "Atlassian (Jira & Confluence)",
		description:
			"Connect to Atlassian products including Jira and Confluence. Search and create issues, access documentation, manage sprints, and integrate your development\u2026",
		owner: "atlassian",
		repo: "atlassian-mcp-server",
		sha: "eb9a5956a7ac6380c731c725a8382da53ad6d980",
		path: "",
	},
	{
		id: "slack",
		displayName: "Slack",
		description:
			"Slack workspace integration. Search messages, access channels, read threads, and stay connected with your team's communications while coding. Find relevant\u2026",
		owner: "slackapi",
		repo: "slack-mcp-plugin",
		sha: "b073ebc2fc500b52e781f5fd17ebb9ad462363dc",
		path: "",
	},
	{
		id: "vercel",
		displayName: "Vercel",
		description:
			"Vercel deployment platform integration. Manage deployments, check build status, access logs, configure domains, and control your frontend infrastructure\u2026",
		owner: "vercel",
		repo: "vercel-plugin",
		sha: "882e66c2698689324c341b7bb8fd8beb92c27bf6",
		path: "",
	},
	{
		id: "stripe",
		displayName: "Stripe",
		description: "Stripe development plugin for Claude",
		owner: "stripe",
		repo: "ai",
		sha: "97b2164821c378f246c3903852057b36a8bd0296",
		path: "providers/claude/plugin",
	},
	{
		id: "cloudflare",
		displayName: "Cloudflare",
		description:
			"Skills for the Cloudflare developer platform: Workers, Durable Objects, Agents SDK, MCP servers, Wrangler CLI, and web performance.",
		owner: "cloudflare",
		repo: "skills",
		sha: "b052c32bab7dd493513260228a36c88294f343f1",
		path: "",
	},
	{
		id: "supabase",
		displayName: "Supabase",
		description:
			"Supabase MCP integration for database operations, authentication, storage, and real-time subscriptions. Manage your Supabase projects, run SQL queries, and\u2026",
		owner: "supabase-community",
		repo: "supabase-plugin",
		sha: "f3f332e0164c34a8392772811737fda0cb972d06",
		path: "",
	},
	{
		id: "figma",
		displayName: "Figma",
		description:
			"Figma design platform integration. Access design files, extract component information, read design tokens, and translate designs into code. Bridge the gap\u2026",
		owner: "figma",
		repo: "mcp-server-guide",
		sha: "f0493295acf5f7cbdebcbcc483c06de814420cb1",
		path: "",
	},
	{
		id: "posthog",
		displayName: "PostHog",
		description:
			"Access PostHog analytics, feature flags, experiments, error tracking, and insights directly from Claude Code.",
		owner: "PostHog",
		repo: "ai-plugin",
		sha: "e0fbf5e742fb4242c4ea509b395b2e343642f0b7",
		path: "",
	},
	{
		id: "neon",
		displayName: "Neon",
		description:
			"Manage your Neon projects and databases with the neon-postgres agent skill and the Neon MCP Server.",
		owner: "neondatabase",
		repo: "agent-skills",
		sha: "827249744ed96416d799b68fb6bf033f4068b18a",
		path: "plugins/neon-postgres",
	},
	{
		id: "context7",
		displayName: "Context7",
		description:
			"Upstash Context7 MCP server for up-to-date documentation lookup. Connects to Context7's hosted remote MCP server (https://mcp.context7.com/mcp) \u2014 no local\u2026",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/context7",
	},
	{
		id: "pagerduty",
		displayName: "PagerDuty",
		description:
			"Enhance code quality and security through PagerDuty risk scoring and incident correlation. Score pre-commit diffs against historical incident data and\u2026",
		owner: "PagerDuty",
		repo: "claude-code-plugins",
		sha: "761cba75bd50fd561405c3b173ecf36084432089",
		path: "",
		settings: [
			{
				key: "PAGERDUTY_API_KEY",
				title: "PAGERDUTY_API_KEY",
				description: "Required by the pagerduty MCP server",
				sensitive: true,
			},
		],
	},
	{
		id: "datadog",
		displayName: "Datadog",
		description:
			"Use Datadog directly in Claude Code through a preconfigured Datadog MCP server. Query logs, metrics, traces, dashboards, and more through natural\u2026",
		owner: "datadog-labs",
		repo: "claude-code-plugin",
		sha: "195f570c002beab3d7bd342739034d0019aa4863",
		path: "",
		settings: [
			{
				key: "DD_MCP_DOMAIN",
				title: "DD_MCP_DOMAIN",
				description: "Required by the mcp MCP server",
				sensitive: false,
			},
			{
				key: "DD_MCP_TOOLSETS",
				title: "DD_MCP_TOOLSETS",
				description: "Required by the mcp MCP server",
				sensitive: false,
			},
		],
	},
	{
		id: "render",
		displayName: "Render",
		description:
			"Deploy, debug, and monitor applications on Render. Includes skills, an agent, slash commands, and a render.yaml validation hook.",
		owner: "render-oss",
		repo: "render-plugin-claude-code",
		sha: "e8f889396634dbc8c368448a7f3de993ed4a5ac1",
		path: "",
	},
	{
		id: "planetscale",
		displayName: "PlanetScale",
		description:
			"An authenticated hosted MCP server that accesses your PlanetScale organizations, databases, branches, schema, and Insights data. Query against your data,\u2026",
		owner: "planetscale",
		repo: "claude-plugin",
		sha: "95c80f9f391be9b1b6172bf82d4191e1ec11b637",
		path: "",
	},
	{
		id: "frontend-design",
		displayName: "Frontend Design",
		description:
			"Create distinctive, production-grade frontend interfaces with high design quality. Generates creative, polished code that avoids generic AI aesthetics.",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "plugins/frontend-design",
	},
];

export const PLUGIN_REQUEST_URL =
	process.env.YTIMESY_PLUGIN_REQUEST_URL ?? null;
