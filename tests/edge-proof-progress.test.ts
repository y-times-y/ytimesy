import { expect, it } from "vitest";
import { verifiedEdgeProofProgress } from "../scripts/edge-proof-progress";

const nonce = "private-file-marker";
const prompt = {
	kind: "userMessage",
	id: "u",
	text: "Reply EDGE_TOOL_PROOF_COMPLETE",
	apiUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
};
const final = {
	kind: "agentMessage",
	id: "a",
	text: `${nonce} EDGE_TOOL_PROOF_COMPLETE`,
};
const tool = {
	kind: "dynamicToolCall",
	id: "t",
	tool: "read_file",
	status: "completed",
	output: nonce,
};
it("rejects the prompt marker, incomplete turns and unverified file reads", () => {
	expect(
		verifiedEdgeProofProgress(
			{ turnStatus: "running", items: [prompt, tool, final] },
			nonce,
		),
	).toBe(false);
	expect(
		verifiedEdgeProofProgress(
			{ turnStatus: "completed", items: [prompt] },
			nonce,
		),
	).toBe(false);
	expect(
		verifiedEdgeProofProgress(
			{ turnStatus: "completed", items: [prompt, final] },
			nonce,
		),
	).toBe(false);
	expect(
		verifiedEdgeProofProgress(
			{ turnStatus: "completed", items: [prompt, tool, final] },
			"another-file",
		),
	).toBe(false);
});
it("accepts only completed assistant output, tool evidence and recorded usage together", () => {
	expect(
		verifiedEdgeProofProgress(
			{ turnStatus: "completed", items: [prompt, tool, final] },
			nonce,
		),
	).toBe(true);
});
