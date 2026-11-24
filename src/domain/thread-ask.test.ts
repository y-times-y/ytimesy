import { describe, expect, it } from "vitest";
import { openThreadAsk } from "./thread-ask";

const ask = (items: unknown[]) => openThreadAsk(items as never);
describe("openThreadAsk", () => {
	it("finds the open question or secret request, and nothing after the person replied", () => {
		const q = { kind: "userQuestion", id: "q", questions: [] };
		const s = { kind: "secretRequest", id: "s", secrets: [] };
		expect(ask([{ kind: "agentMessage", id: "a" }, q])?.kind).toBe("question");
		expect(ask([s])?.kind).toBe("secret");
		expect(ask([q, { kind: "userMessage", id: "u" }])).toBeNull();
	});
	it("leaves pushes and plans to the thread's own card", () => {
		expect(ask([{ kind: "pushApproval", id: "p" }])).toBeNull();
		expect(ask([{ kind: "planProposal", id: "p" }])).toBeNull();
	});
});
