/**
 * The Node program that runs one Claude Code run through the Claude Agent
 * SDK on the chat's VM (argv: SDK module path, inputs directory, cwd). It
 * reads its inputs from files the runner wrote (options.json, mcp.json,
 * system, prompt), takes its credentials from the environment, and prints
 * each SDK message as one JSON line: the same messages as Claude Code's
 * stream-json output, so src/domain/claude-code-stream.ts reads either.
 * Claude Code's stderr goes to stderr, where failures are classified.
 * Exits 0 once a result message was printed, 1 otherwise.
 */
export const CLAUDE_AGENT_RUNNER_SCRIPT = `import { readFileSync, writeFileSync } from "node:fs";
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
const write = (line) =>
	new Promise((resolve) => (process.stdout.write(line) ? resolve() : process.stdout.once("drain", resolve)));
let finished = false;
for await (const message of query({ prompt: read("prompt"), options })) {
	if (message.type === "system" && message.subtype === "init" && /^[a-f0-9-]{36}$/i.test(message.session_id ?? ""))
		writeFileSync(inputs + "/active-session", message.session_id, { mode: 0o600 });
	await write(JSON.stringify(message) + "\\n");
	if (message.type === "result") finished = true;
}
process.exitCode = finished ? 0 : 1;
`;
