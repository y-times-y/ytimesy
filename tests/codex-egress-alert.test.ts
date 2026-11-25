import { expect, it } from "vitest";
import {
	codexEgressBlockedAlert,
	codexEgressExhaustedAlert,
} from "#/domain/owner-alerts";

const at = new Date("2026-11-25T00:34:29Z");

it("says Codex chats are failing, and what to do, when no other path exists", () => {
	const alert = codexEgressBlockedAlert("tunnel", "transport", {}, at);
	expect(alert.subject).toContain("Codex chats failing");
	expect(alert.text).toContain("failing right now");
	expect(alert.text).toContain("Elastic IP");
	expect(alert.key).toBe("tunnel:blocked:2026-11-25T00");
});

it("names the path that serves traffic when a fallback exists", () => {
	const alert = codexEgressBlockedAlert(
		"tunnel",
		"transport",
		{ fallbacks: ["vpc"], detail: "TimeoutError" },
		at,
	);
	expect(alert.subject).toContain("served by vpc");
	expect(alert.text).toContain("still being served");
	expect(alert.text).not.toContain("failing right now");
});

it("says chats fail when every path is blocked and gives each path's remedy", () => {
	const alert = codexEgressExhaustedAlert(
		[
			{ path: "tunnel", reason: "transport" },
			{ path: "vpc", reason: "forbidden-html" },
		],
		at,
	);
	expect(alert.subject).toContain("failing");
	expect(alert.text).toContain("tunnel:");
	expect(alert.text).toContain("CODEX_EGRESS");
});
