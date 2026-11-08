import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	type EvidenceRecord,
	evidenceAge,
	evidenceContext,
} from "#/domain/pr-evidence";
import { EvidenceCard, EvidenceDetail, EvidenceSummary } from "./evidence-view";

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

	it("adds no chat card for a pull request capture with only CLI output", () => {
		const cliOnly = {
			...shot,
			source: "harness",
			fullName: "y-times-y/ytimesy",
			pullNumber: 23,
			kind: "cli",
			status: "captured",
			files: [{ name: "cli.txt", bytes: 10, sha256: "0".repeat(64) }],
		} as EvidenceRecord;
		expect(renderToStaticMarkup(<EvidenceCard evidence={cliOnly} />)).toBe("");
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

describe("the evidence page header", () => {
	const SESSION = "11111111-1111-4111-8111-111111111111";
	const NOW = "2026-11-02T14:00:00.000Z";

	it("names the pull request, repository, branch and chat, with links to both", () => {
		const context = evidenceContext(recording, {
			chatTitle: "Add the import flow",
			chatBranch: "ytimesy/old",
			link: {
				fullName: "hetpatel-11/demo",
				pullNumber: 7,
				headRef: "ytimesy/import-flow",
			},
		});
		expect(context.pullRequest?.url).toBe(
			"https://github.com/hetpatel-11/demo/pull/7",
		);
		expect(context.chatPath).toBe(`/?project=${PROJECT}&chat=${SESSION}`);
		const html = renderToStaticMarkup(
			<EvidenceSummary context={context} now={NOW} />,
		);
		expect(html).toContain("#7 · </span>Add the import flow");
		expect(html).toContain("hetpatel-11/demo");
		expect(html).toContain(">ytimesy/import-flow</code>");
		expect(html).toContain("2 h ago");
		expect(html).toContain('dateTime="2026-11-02T12:00:00.000Z"');
		expect(html).toContain(
			'href="https://github.com/hetpatel-11/demo/pull/7" target="_blank"',
		);
		expect(html).toContain("Open the pull request on GitHub");
		expect(html).toContain(`href="/?project=${PROJECT}&amp;chat=${SESSION}"`);
		expect(html).toContain("Back to the chat");
		expect(html).not.toContain("No pull request yet");
	});

	it("shows the chat and its branch when no pull request exists yet", () => {
		const context = evidenceContext(shot, {
			chatTitle: "Fix the header",
			chatBranch: "ytimesy/fix-header",
			link: null,
		});
		const html = renderToStaticMarkup(
			<EvidenceSummary context={context} now={NOW} />,
		);
		expect(html).toContain("No pull request yet");
		expect(html).toContain("Fix the header");
		expect(html).toContain(">ytimesy/fix-header</code>");
		expect(html).not.toContain("github.com");
		expect(html).not.toContain("#");
		expect(html).toContain("Back to the chat");
	});

	it("uses a harness capture's own pull request and short commit", () => {
		const harness = {
			...shot,
			source: "harness",
			fullName: "acme/web",
			pullNumber: 12,
			commitSha: "abcdef1234567890abcdef1234567890abcdef12",
		} satisfies EvidenceRecord;
		const context = evidenceContext(harness, {
			chatTitle: null,
			chatBranch: null,
			link: null,
		});
		expect(context.chatPath).toBeNull();
		const html = renderToStaticMarkup(
			<EvidenceSummary context={context} now={NOW} />,
		);
		expect(html).toContain("Pull request #12");
		expect(html).toContain(">abcdef1</code>");
		expect(html).toContain('href="https://github.com/acme/web/pull/12"');
		expect(html).not.toContain("Back to the chat");
	});

	it("leaves out an unusable repository name and a placeholder chat title", () => {
		const context = evidenceContext(shot, {
			chatTitle: "New session",
			chatBranch: null,
			link: { fullName: "bad name", pullNumber: 3, headRef: null },
		});
		expect(context.pullRequest).toBeNull();
		expect(context.chatTitle).toBeNull();
		expect(context.chatPath).not.toBeNull();
	});
});

describe("evidenceAge", () => {
	const at = "2026-11-02T12:00:00.000Z";
	const later = (ms: number) => Date.parse(at) + ms;
	it("reads like a person would say it", () => {
		expect(evidenceAge(at, later(10_000))).toBe("just now");
		expect(evidenceAge(at, later(5 * 60_000))).toBe("5 min ago");
		expect(evidenceAge(at, later(3 * 3_600_000))).toBe("3 h ago");
		expect(evidenceAge(at, later(26 * 3_600_000))).toBe("1 day ago");
		expect(evidenceAge("nope", later(0))).toBe("");
	});
});
