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
	/**
	 * Reviewed URL per MCP server name that signs each user in with their own account,
	 * for providers whose plugin points at a shared keyless endpoint.
	 */
	readonly signInUrls?: Readonly<Record<string, string>>;
	/**
	 * The owner's OAuth app (MCP_OAUTH_<app>_CLIENT_ID/_SECRET) that can sign
	 * users in instead of the plugin's credential settings. When configured,
	 * those settings are optional: left empty, the server installs as sign-in.
	 */
	readonly signInApp?: string;
	readonly settings?: readonly {
		readonly key: string;
		readonly title: string;
		readonly description: string;
		readonly sensitive: boolean;
	}[];
};

// Reviewed 2026-10-11 from Anthropic's official marketplace (anthropics/claude-plugins-official@f359d43);
// each entry was fetched and parsed at this exact commit. Sign-in (OAuth) MCP servers install as
// OAuth servers that join turns once the user signs in.
// Removed 2026-11-03: Vercel and Figma. Their MCP sign-in accepts only apps they
// have approved (Vercel refuses our redirect URI, Figma's registration answers
// 403), so neither could ever connect here.
export const PLUGIN_CATALOG: readonly PluginCatalogEntry[] = [
	{
		id: "github",
		displayName: "GitHub",
		description:
			"Issues, pull requests, code review and repository search on GitHub.",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/github",
		signInApp: "GITHUB",
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
			"Repositories, merge requests, CI/CD pipelines, issues and wikis on GitLab.",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/gitlab",
	},
	{
		id: "linear",
		displayName: "Linear",
		description: "Create and update Linear issues, projects and statuses.",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/linear",
	},
	{
		id: "sentry",
		displayName: "Sentry",
		description: "Sentry error reports, stack traces and issue search.",
		owner: "getsentry",
		repo: "plugin-claude",
		sha: "73e53541d7af21672e27428c7067f4264b8a3d65",
		path: "",
	},
	{
		id: "notion",
		displayName: "Notion",
		description:
			"Notion workspace integration. Search pages, create and update documents, manage databases, and access your team's knowledge base.",
		owner: "makenotion",
		repo: "claude-code-notion-plugin",
		sha: "9847f2aa1a15f25df35ed1fb7b4557dbb60cd651",
		path: "",
	},
	{
		id: "atlassian",
		displayName: "Atlassian (Jira & Confluence)",
		description: "Jira issues and sprints, and Confluence docs.",
		owner: "atlassian",
		repo: "atlassian-mcp-server",
		sha: "eb9a5956a7ac6380c731c725a8382da53ad6d980",
		path: "",
	},
	{
		id: "slack",
		displayName: "Slack",
		description: "Search Slack messages, channels and threads.",
		owner: "slackapi",
		repo: "slack-mcp-plugin",
		sha: "b073ebc2fc500b52e781f5fd17ebb9ad462363dc",
		path: "",
	},
	{
		id: "stripe",
		displayName: "Stripe",
		description: "Stripe payments, customers and API docs for development.",
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
		description: "Supabase projects, SQL, auth, storage and realtime.",
		owner: "supabase-community",
		repo: "supabase-plugin",
		sha: "f3f332e0164c34a8392772811737fda0cb972d06",
		path: "",
	},
	{
		id: "posthog",
		displayName: "PostHog",
		description:
			"Access PostHog analytics, feature flags, experiments, error tracking, and insights.",
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
		// Exa's own plugin (exa-labs/exa-mcp-server, reviewed 2026-10-12). Its plugin points at the
		// shared keyless endpoint; ?login makes each user sign in to their own Exa account.
		id: "exa",
		displayName: "Exa web search",
		description:
			"Exa web search, page fetching and multi-step research for any model. Each user signs in to their own Exa account.",
		owner: "exa-labs",
		repo: "exa-mcp-server",
		sha: "e9c3b0126a3373eb1aeaca162e84d0791ff4c7f7",
		path: "",
		signInUrls: { exa: "https://mcp.exa.ai/mcp?login" },
	},
	{
		id: "context7",
		displayName: "Context7",
		description: "Up-to-date library docs from Context7's hosted MCP server.",
		owner: "anthropics",
		repo: "claude-plugins-official",
		sha: "f359d43b406057f1a8cdbc4ea93b827642c162e6",
		path: "external_plugins/context7",
	},
	{
		id: "pagerduty",
		displayName: "PagerDuty",
		description: "PagerDuty risk scores and incident history for your changes.",
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
			"Query Datadog logs, metrics, traces and dashboards through a preconfigured Datadog MCP server.",
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
			"PlanetScale organizations, databases, branches, schema and Insights.",
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
