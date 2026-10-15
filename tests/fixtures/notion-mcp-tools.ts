/**
 * A synthesized stand-in for the hosted Notion MCP server's tools/list
 * (mcp.notion.com). Notion does not publish the list; it is only served to a
 * signed-in client. Tool names follow the hosted server; descriptions and
 * schemas are written to a comparable shape and length (long Markdown-format
 * guidance on the page-writing tools, short ones on lookups). Used to measure
 * tool-definition size, not to describe Notion's exact contract.
 */
const PAGE_MARKDOWN_GUIDE = `Page content is Notion-flavored Markdown. Supported blocks: headings (#, ##, ###), paragraphs, bulleted and numbered lists, to-do items ("- [ ]" and "- [x]"), toggles (a "<details><summary>" element whose children are indented with a tab), quotes, callouts ("<callout icon=\\"emoji\\" color=\\"color\\">" with tab-indented children), dividers ("---"), code blocks with a language, equations ("$$"), tables (a "<table>" element with "<tr>" and "<td>" rows; header-row and header-column attributes), columns ("<columns>" containing "<column>" elements), images, files, PDFs, audio and video ("<image source=\\"url\\">caption</image>"), page mentions ("<mention-page url=\\"...\\"/>"), database mentions, user mentions ("<mention-user url=\\"user://id\\"/>"), date mentions ("<mention-date start=\\"YYYY-MM-DD\\"/>"), and synced blocks. Rich text supports bold, italic, strikethrough, underline, inline code, links, colors ("<span color=\\"red\\">") and inline equations. Indent children with tabs, never spaces. Escape literal angle brackets. Empty lines are dropped; use "<empty-block/>" for an intentional blank line. Content that does not fit a supported block is converted to a paragraph. To place a database in a page, create the database with this page as its parent rather than writing a table. Do not include the page title in the content; it is a property.`;

const PROPERTY_GUIDE = `Properties are a map from property name to value. For a page under another page, the only property is "title". For a page in a data source, keys must match the data source's schema exactly (fetch the data source first to read it). Value formats: title and rich_text are strings; number is a number; checkbox is "__YES__" or "__NO__"; select and status are the option name; multi_select is a JSON array of option names; date properties are expanded into "date:<name>:start", "date:<name>:end" (ISO-8601 dates or date-times) and "date:<name>:is_datetime" (1 or 0); place properties are expanded into "place:<name>:name", "place:<name>:address", "place:<name>:latitude", "place:<name>:longitude"; people is a JSON array of user ids; relation is a JSON array of page URLs; url, email and phone_number are strings. Properties named "id" or "url" (case-insensitive) must be prefixed with "userDefined:". Formula, rollup, created_time, created_by, last_edited_time, last_edited_by and unique_id are read-only and must be omitted.`;

const parent = {
	type: "object",
	description:
		"Where to create the content. Omit to create a private workspace-level page.",
	properties: {
		page_id: { type: "string", description: "The parent page's ID or URL." },
		database_id: {
			type: "string",
			description:
				"A database ID; only valid when it has exactly one data source.",
		},
		data_source_id: {
			type: "string",
			description: "The data source (collection) ID to add rows to.",
		},
		type: {
			type: "string",
			enum: ["page_id", "database_id", "data_source_id"],
		},
	},
	additionalProperties: false,
} as const;

const propertySchema = {
	type: "object",
	description:
		"A data source property definition keyed by property name: its type and type-specific options.",
	additionalProperties: {
		type: "object",
		properties: {
			type: {
				type: "string",
				enum: [
					"title",
					"rich_text",
					"number",
					"select",
					"multi_select",
					"status",
					"date",
					"people",
					"files",
					"checkbox",
					"url",
					"email",
					"phone_number",
					"formula",
					"relation",
					"rollup",
					"created_time",
					"created_by",
					"last_edited_time",
					"last_edited_by",
					"unique_id",
					"place",
				],
			},
			options: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string" },
						color: {
							type: "string",
							enum: [
								"default",
								"gray",
								"brown",
								"orange",
								"yellow",
								"green",
								"blue",
								"purple",
								"pink",
								"red",
							],
						},
						description: { type: "string" },
					},
					required: ["name"],
				},
			},
			number_format: { type: "string" },
			expression: { type: "string" },
			data_source_id: { type: "string" },
			relation_property: { type: "string" },
			rollup_function: { type: "string" },
			prefix: { type: "string" },
		},
		required: ["type"],
	},
} as const;

export const notionMcpTools = [
	{
		name: "notion-search",
		description: `Search the user's Notion workspace and connected sources (Slack, Google Drive, GitHub, Jira, Microsoft Teams, SharePoint, OneDrive, Linear) with semantic search, or search users by name or email. Use it to find pages, databases and data sources before fetching them. Results contain titles, URLs, a highlight and the last-edited time; fetch a result for its full content. Search a specific page or data source by passing its URL as "data_source_url" or "page_url" to scope the search to its contents and descendants. Use "query_type": "user" to look up people by name or email. If the workspace has no Notion AI access, search falls back to workspace title search and connected sources are unavailable. Filters narrow results by creation date range and creator. Prefer several narrow queries over one broad one; repeat with different wording when results are thin. Do not use search to list every page in a workspace.`,
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					minLength: 1,
					description:
						"Semantic search query. For users, a name or email fragment.",
				},
				query_type: { type: "string", enum: ["internal", "user"] },
				data_source_url: {
					type: "string",
					description:
						"Scope the search to one data source (collection://...).",
				},
				page_url: {
					type: "string",
					description: "Scope the search to a page and its descendants.",
				},
				teamspace_id: { type: "string" },
				filters: {
					type: "object",
					properties: {
						created_date_range: {
							type: "object",
							properties: {
								start_date: { type: "string", format: "date" },
								end_date: { type: "string", format: "date" },
							},
						},
						created_by_user_ids: {
							type: "array",
							items: { type: "string" },
							maxItems: 100,
						},
					},
					additionalProperties: false,
				},
				page_size: { type: "integer", minimum: 1, maximum: 25 },
				max_highlight_length: { type: "integer", minimum: 0, maximum: 500 },
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-fetch",
		description: `Retrieve the full content of a Notion page, database or data source, or of a connected-source result, by URL or ID. Pages are returned as Notion-flavored Markdown with their properties, child page and database mentions, and discussion anchors. Databases return their title, description, schema (property names, types and options for each data source) and views with their filters and sorts; data sources return their schema and a link for each view. Use fetch after search to read a result, before updating a page to see its current content, and before creating pages in a data source to learn its property schema. Long pages are truncated; follow the returned continuation cursor. Set "include_discussions" to receive comment thread anchors in the content. Template pages are listed for a data source when present. Fetching a "collection://" URL returns that data source; fetching a "view://" URL returns the view configuration. Do not guess property names; read them here.`,
		inputSchema: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description:
						"Page, database or data source URL or ID; also collection:// and view:// URLs.",
				},
				include_discussions: { type: "boolean" },
				include_transcript: { type: "boolean" },
				cursor: { type: "string" },
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-create-pages",
		description: `Create one or more Notion pages with properties and content, under a page, in a data source, or at workspace level. Up to 100 pages per call share one parent. When the parent is a data source, fetch it first and use its exact property names and value formats; when the parent is a page, set only "title". Use a template by passing "template_id" from the data source's templates instead of content. ${PROPERTY_GUIDE}\n\n${PAGE_MARKDOWN_GUIDE}\n\nExamples: a meeting-notes page under a page: {"parent":{"page_id":"..."},"pages":[{"properties":{"title":"Weekly sync"},"content":"## Agenda\\n- Roadmap\\n- Hiring"}]}. A task in a tasks data source: {"parent":{"data_source_id":"..."},"pages":[{"properties":{"Task name":"Ship docs","Status":"In progress","date:Due:start":"2026-10-20","date:Due:is_datetime":0}}]}.`,
		inputSchema: {
			type: "object",
			properties: {
				parent,
				pages: {
					type: "array",
					minItems: 1,
					maxItems: 100,
					items: {
						type: "object",
						properties: {
							properties: {
								type: "object",
								additionalProperties: {
									type: ["string", "number", "null"],
								},
							},
							content: { type: "string" },
							template_id: { type: "string" },
							icon: { type: "string" },
							cover: { type: "string" },
						},
						additionalProperties: false,
					},
				},
			},
			required: ["pages"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-update-page",
		description: `Update a Notion page's properties or content. Commands: "update_properties" sets the given properties (others are unchanged); "replace_content" replaces the whole body; "replace_content_range" replaces the text matched by "selection_with_ellipsis" (the first and last few words of a unique span, joined by "..."); "insert_content_after" inserts after the matched span; "apply_template" applies a data source template. Fetch the page first: selections must match its current Markdown exactly, including formatting characters. Replacing content deletes child pages and databases it no longer mentions unless "allow_deleting_content" is true; keep their mention tags to preserve them. ${PROPERTY_GUIDE}\n\n${PAGE_MARKDOWN_GUIDE}`,
		inputSchema: {
			type: "object",
			properties: {
				page_id: { type: "string" },
				command: {
					type: "string",
					enum: [
						"update_properties",
						"replace_content",
						"replace_content_range",
						"insert_content_after",
						"apply_template",
					],
				},
				properties: {
					type: "object",
					additionalProperties: { type: ["string", "number", "null"] },
				},
				new_str: { type: "string" },
				selection_with_ellipsis: { type: "string" },
				allow_deleting_content: { type: "boolean" },
				template_id: { type: "string" },
				icon: { type: "string" },
				cover: { type: "string" },
			},
			required: ["page_id", "command"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-move-pages",
		description:
			"Move one or more pages or databases to a new parent page, data source or the workspace level. Up to 100 items per call. The new parent must be one the user can edit. Moving into a data source requires compatible properties; properties missing from the target schema are dropped.",
		inputSchema: {
			type: "object",
			properties: {
				page_or_database_ids: {
					type: "array",
					items: { type: "string" },
					minItems: 1,
					maxItems: 100,
				},
				new_parent: {
					type: "object",
					properties: {
						type: {
							type: "string",
							enum: ["page_id", "database_id", "data_source_id", "workspace"],
						},
						page_id: { type: "string" },
						database_id: { type: "string" },
						data_source_id: { type: "string" },
					},
					required: ["type"],
				},
			},
			required: ["page_or_database_ids", "new_parent"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-duplicate-page",
		description:
			"Duplicate a page and its content under the same parent. Duplication completes asynchronously for large pages; the new page's URL is returned immediately and fills in over the next seconds.",
		inputSchema: {
			type: "object",
			properties: { page_id: { type: "string" } },
			required: ["page_id"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-create-database",
		description: `Create a database with one initial data source and a default table view, under a page or at workspace level. Define the schema as properties keyed by name; exactly one property must be the title. Select, multi-select and status options can be given with colors. Relations point at a data source by ID and may be one- or two-way. Rollups name a relation property, a target property and a function. Formulas use Notion formula 2.0 syntax and reference properties with prop("Name"). Returns the database URL, data source ID and schema. Add rows afterwards with notion-create-pages using the data source as parent.`,
		inputSchema: {
			type: "object",
			properties: {
				parent: {
					type: "object",
					properties: { page_id: { type: "string" } },
				},
				title: { type: "string" },
				description: { type: "string" },
				properties: propertySchema,
				is_inline: { type: "boolean" },
			},
			required: ["properties"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-update-data-source",
		description: `Update a data source's schema, name or description, or a database's title, inline state or trash state. Add properties by giving new names; rename by giving {"name": "New"} for an existing property; remove by setting a property to null. Changing a property's type converts existing values when possible and may lose data (for example text to number). Fetch the data source first to see its schema.`,
		inputSchema: {
			type: "object",
			properties: {
				data_source_id: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
				properties: propertySchema,
				is_inline: { type: "boolean" },
				in_trash: { type: "boolean" },
			},
			required: ["data_source_id"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-query-data-sources",
		description:
			"Query one or more data sources with SQL-like filters and sorts, or run a saved view. Use when you need rows matching conditions rather than semantic search. Each data source is a table named by its collection:// URL; columns are its property names, quoted with double quotes. Date columns are expanded as in page properties. Results are paginated.",
		inputSchema: {
			type: "object",
			properties: {
				data: {
					type: "object",
					properties: {
						mode: { type: "string", enum: ["sql", "view"] },
						data_source_urls: { type: "array", items: { type: "string" } },
						query: { type: "string" },
						params: { type: "array", items: {} },
						view_url: { type: "string" },
					},
					required: ["mode"],
				},
				cursor: { type: "string" },
			},
			required: ["data"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-create-comment",
		description:
			"Add a comment to a page, or reply in an existing discussion. Comments are rich text: plain text, mentions of users, pages and dates, and links. To comment on a specific span, pass the discussion ID from a fetched page's discussion anchors.",
		inputSchema: {
			type: "object",
			properties: {
				parent: {
					type: "object",
					properties: { page_id: { type: "string" } },
					required: ["page_id"],
				},
				discussion_id: { type: "string" },
				rich_text: {
					type: "array",
					items: {
						type: "object",
						properties: {
							type: { type: "string", enum: ["text", "mention", "equation"] },
							text: {
								type: "object",
								properties: {
									content: { type: "string" },
									link: { type: ["object", "null"] },
								},
							},
							annotations: { type: "object" },
						},
					},
				},
			},
			required: ["rich_text"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-get-comments",
		description:
			"List the comments on a page, including resolved discussions when requested, with authors and timestamps.",
		inputSchema: {
			type: "object",
			properties: {
				page_id: { type: "string" },
				include_resolved: { type: "boolean" },
				include_all_blocks: { type: "boolean" },
			},
			required: ["page_id"],
			additionalProperties: false,
		},
	},
	{
		name: "notion-get-teams",
		description:
			"List the teamspaces in the workspace, the ones the user belongs to first, with their IDs, names and the user's role.",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			additionalProperties: false,
		},
	},
	{
		name: "notion-get-users",
		description:
			"List the workspace's users and bots with names, emails and IDs, optionally filtered by a name or email fragment. Use the IDs for people properties and mentions.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
				start_cursor: { type: "string" },
				page_size: { type: "integer", minimum: 1, maximum: 100 },
				user_id: { type: "string" },
			},
			additionalProperties: false,
		},
	},
	{
		name: "notion-get-self",
		description:
			"Return the signed-in user's identity and the workspace this connection uses.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
];
