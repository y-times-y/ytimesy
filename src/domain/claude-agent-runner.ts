import { CLAUDE_BOX_TOOLS_ACTIVE } from "./claude-box-tools";
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
 * next step, not after the turn. Any failure reads as none. While its feed
 * is connected to an object that says what is waiting, the hook after a
 * tool call asks only when there is a sent message it has not fetched
 * (claude-feed-sender.ts): no request, and no woken object, otherwise. The
 * hook before stopping always asks (once a run, and nothing may be lost).
 *
 * When options.json names a feed (YTIMESY_CLAUDE_FEED), it also pushes each
 * line to the chat's object over a WebSocket (claude-feed-sender.ts), where
 * Node has one; stdout is written first and stays complete either way.
 *
 * When options.json names box tools (a runner box run with
 * YTIMESY_CLAUDE_BOX_TOOLS, claude-box-tools.ts), it imports that module,
 * which reads and deletes the run's grant file and serves ytimesy's tools on
 * 127.0.0.1: the lean workspace tools run there against the chat's VM, the
 * rest go on to the edge. Claude Code's "ytimesy" server is then that local
 * one; the inbox, the feed and the forwarded calls keep the edge's address.
 * It writes the served tools' names to box-tools-active for the step. If
 * they do not start, every tool stays on the edge, as without them.
 */
export const CLAUDE_AGENT_RUNNER_SCRIPT = `import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
let boxTools = null;
if (settings.boxTools?.module && inboxServer?.url) {
	try {
		const { startBoxTools } = await import(settings.boxTools.module);
		boxTools = await startBoxTools({
			configPath: inputs + "/" + settings.boxTools.config,
			edge: { url: inboxServer.url, headers: inboxServer.headers ?? {} },
		});
		options.mcpServers = { ...mcpServers, ytimesy: { type: "http", url: boxTools.url, headers: boxTools.headers } };
		writeFileSync(inputs + "/${CLAUDE_BOX_TOOLS_ACTIVE}", JSON.stringify(boxTools.local), { mode: 0o600 });
	} catch (error) {
		boxTools = null;
		process.stderr.write("ytimesy box tools did not start; the edge serves them: " + String(error?.message ?? error).slice(0, 300) + "\\n");
	}
	// The grant file is never left behind, whether the module read it or not.
	try { rmSync(inputs + "/" + settings.boxTools.config, { force: true }); } catch {}
}
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
let feed = null;
/** After a tool call: what was sent meanwhile, asked over HTTP only when the feed cannot rule it out. */
const inboxAfterTool = async () => {
	const due = feed ? feed.inboxDue() : null;
	if (due === "") return "";
	const text = await inbox();
	// A key is fetched once something came back; an empty answer asks again next time.
	if (due !== null && text) feed.inboxFetched(due);
	return text;
};
options.hooks = {
	PostToolUse: [{ timeout: 180, hooks: [async () => {
		const text = await inboxAfterTool();
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
feed = settings.feed?.url && feedGrant && typeof WebSocket === "function"
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
await boxTools?.close().catch(() => {});
`;
