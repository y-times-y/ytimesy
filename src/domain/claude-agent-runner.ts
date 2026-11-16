import { CLAUDE_FEED_SENDER_SOURCE } from "./claude-feed-sender";

/**
 * The Node program that runs one Claude Code run through the Claude Agent
 * SDK on the chat's VM (argv: SDK module path, inputs directory, cwd). It
 * reads its inputs from files the runner wrote (options.json, mcp.json,
 * system, prompt), takes its credentials from the environment, and prints
 * each SDK message as one JSON line: the same messages as Claude Code's
 * stream-json output, so src/domain/claude-code-stream.ts reads either.
 * Claude Code's stderr goes to stderr, where failures are classified.
 * Exits 0 once a result message was printed, 1 otherwise.
 *
 * After each tool call, and before the run would end, its hooks ask ytimesy
 * (the MCP server's address, a method no tool list shows) for messages the
 * user sent meanwhile: Send on a queued message reaches the model at its
 * next step, not after the turn. Any failure reads as none.
 *
 * When options.json names a feed (YTIMESY_CLAUDE_FEED), it also pushes each
 * line to the chat's object over a WebSocket (claude-feed-sender.ts), where
 * Node has one; stdout is written first and stays complete either way.
 */
export const CLAUDE_AGENT_RUNNER_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
${CLAUDE_FEED_SENDER_SOURCE}
const [sdkModule, inputs, cwd] = process.argv.slice(2);
const { query } = await import(sdkModule);
const read = (name) => readFileSync(inputs + "/" + name, "utf8");
const settings = JSON.parse(read("options.json"));
const { mcpServers } = JSON.parse(read("mcp.json"));
const options = {
	cwd,
	model: settings.model,
	permissionMode: "bypassPermissions",
	allowDangerouslySkipPermissions: true,
	mcpServers,
	strictMcpConfig: true,
	disallowedTools: settings.disallowedTools,
	// Without display "summarized" the API sends thinking blocks with their text omitted (only a signature), so the chat shows no reasoning.
	thinking: { type: "adaptive", display: "summarized" },
	systemPrompt: { type: "preset", preset: "claude_code", append: read("system") },
	stderr: (data) => process.stderr.write(data),
};
if (settings.resume) options.resume = settings.resume;
if (settings.effort) options.effort = settings.effort;
const inboxServer = mcpServers?.ytimesy;
const inbox = async () => {
	if (!inboxServer?.url) return "";
	try {
		const response = await fetch(inboxServer.url, {
			method: "POST",
			headers: { ...inboxServer.headers, "content-type": "application/json", accept: "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ytimesy/inbox" }),
			signal: AbortSignal.timeout(170000),
		});
		const reply = await response.json();
		return typeof reply?.result?.text === "string" ? reply.result.text : "";
	} catch {
		return "";
	}
};
options.hooks = {
	PostToolUse: [{ timeout: 180, hooks: [async () => {
		const text = await inbox();
		return text ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } } : {};
	}] }],
	Stop: [{ timeout: 180, hooks: [async () => {
		const text = await inbox();
		return text ? { decision: "block", reason: text } : {};
	}] }],
};
const write = (line) =>
	new Promise((resolve) => (process.stdout.write(line) ? resolve() : process.stdout.once("drain", resolve)));
const feedGrant = /^Bearer\\s+(\\S+)$/i.exec(inboxServer?.headers?.Authorization ?? "")?.[1];
const feed = settings.feed?.url && feedGrant && typeof WebSocket === "function"
	? createFeed({ url: settings.feed.url, turnId: settings.feed.turnId, run: settings.feed.run, grant: feedGrant })
	: null;
let finished = false;
let failed = false;
try {
	for await (const message of query({ prompt: read("prompt"), options })) {
		if (message.type === "system" && message.subtype === "init" && /^[a-f0-9-]{36}$/i.test(message.session_id ?? ""))
			writeFileSync(inputs + "/active-session", message.session_id, { mode: 0o600 });
		const line = JSON.stringify(message);
		await write(line + "\\n");
		feed?.push(line, message);
		if (message.type === "result") finished = true;
	}
} catch (error) {
	// Written before the feed's goodbye (which can take seconds): the step
	// classifies the run's failure from this text.
	process.stderr.write(String(error?.stack ?? error) + "\\n");
	failed = true;
}
process.exitCode = finished && !failed ? 0 : 1;
await feed?.finish(process.exitCode);
`;
