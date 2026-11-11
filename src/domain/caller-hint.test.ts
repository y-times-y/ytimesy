import { expect, it } from "vitest";
import { callerHintFromStack } from "./caller-hint";

const stack = [
	"Error",
	"    at noteFullSessionRead (file:///app/agent-sessions.js:10:5)",
	"    at async agentSessionForOwner (file:///app/agent-sessions.js:20:3)",
	"    at async queueMessage (file:///app/queued.js:5:9)",
	"    at async withScope (node:internal/x:1:1)",
	"    at async runStep (file:///app/api-turn.js:100:1)",
	"    at async advance (file:///app/executor.js:7:7)",
].join("\n");

it("names the callers beyond the helper's own frames, without paths", () => {
	expect(
		callerHintFromStack(stack, ["agent-sessions", "noteFullSessionRead"]),
	).toBe("queueMessage < runStep < advance");
	expect(callerHintFromStack(stack, ["agentSessionForOwner"], 2)).toBe(
		"noteFullSessionRead < queueMessage",
	);
});

it("copes with no stack or an empty one", () => {
	expect(callerHintFromStack(undefined)).toBe("");
	expect(callerHintFromStack("Error")).toBe("");
});
