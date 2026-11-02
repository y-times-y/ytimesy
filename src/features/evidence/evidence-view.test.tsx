import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EvidenceRecord } from "#/domain/pr-evidence";
import { EvidenceCard, EvidenceDetail } from "./evidence-view";

const PROJECT = "22222222-2222-4222-8222-222222222222";

function agentCapture(id: string, name: string, videoSeconds: number | null) {
	return {
		id,
		projectId: PROJECT,
		sessionId: "11111111-1111-4111-8111-111111111111",
		source: "agent",
		itemId: "turn:call",
		fullName: "",
		pullNumber: 0,
		commitSha: "",
		headSha: null,
		kind: "web",
		status: "captured",
		reason: "",
		startCommand: "",
		urls: [],
		files: [{ name, bytes: 10, sha256: "0".repeat(64) }],
		manifest: null,
		browser: "",
		videoSeconds,
		captureStartedAt: null,
		captureFinishedAt: null,
		createdAt: "2026-11-02T12:00:00.000Z",
		expiresAt: "2026-12-02T12:00:00.000Z",
	} satisfies EvidenceRecord;
}

const shot = agentCapture(
	"33333333-3333-4333-8333-333333333333",
	"screenshot-a.png",
	null,
);
const recording = agentCapture(
	"44444444-4444-4444-8444-444444444444",
	"recording-a.mp4",
	5,
);
const media = (record: EvidenceRecord) =>
	`/api/projects/${PROJECT}/evidence/${record.id}/${record.files[0]?.name}`;

describe("agent captures in the chat", () => {
	it("shows a screenshot inline, linked to full size", () => {
		const html = renderToStaticMarkup(<EvidenceCard evidence={shot} />);
		expect(html).toContain(`<img src="${media(shot)}"`);
		expect(html).toContain(`<a href="${media(shot)}" target="_blank"`);
		expect(html).toContain("Screenshot");
		expect(html).not.toContain("Evidence for");
	});

	it("plays a recording inline", () => {
		const html = renderToStaticMarkup(<EvidenceCard evidence={recording} />);
		expect(html).toContain(
			`<video controls="" preload="metadata" src="${media(recording)}"`,
		);
		expect(html).toContain("Recording, 5 s");
	});

	it("shows every capture of the chat on the evidence page the pull request links", () => {
		const html = renderToStaticMarkup(
			<EvidenceDetail evidence={recording} captures={[recording, shot]} />,
		);
		expect(html).toContain("1 screenshot, 1 recording (5 s)");
		expect(html.indexOf(media(shot))).toBeLessThan(
			html.indexOf(media(recording)),
		);
	});
});
