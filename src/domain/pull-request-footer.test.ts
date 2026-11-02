import { expect, it } from "vitest";
import { withEvidenceSection } from "./pr-evidence";
import { withPullRequestFooter } from "./pull-request-footer";
import { descriptionKeepingEvidence } from "./pull-request-handoff";

const footer = {
	fixUrl: "https://app/fix/1",
	mention: "@ytimesy-agent",
	chatUrl: "https://app/?project=p&chat=c",
};

it("ends the description with one footer naming the App's handle", () => {
	const body = withPullRequestFooter("Adds the parser.", footer);
	expect(body).toContain("[Fix with ytimesy](https://app/fix/1)");
	expect(body).toContain("`@ytimesy-agent <what to change>`");
	expect(body).not.toMatch(/@ytimesy[^-]/);
	expect(body.trimEnd()).toMatch(
		/Generated with \[ytimesy\]\(https:\/\/app\/\?project=p&chat=c\)\n<!-- ytimesy-fix:end -->$/,
	);
});

it("replaces the footer on updates and keeps it last", () => {
	const once = withPullRequestFooter("Adds the parser.", footer);
	const again = withPullRequestFooter(`${once}\n\nmore`, {
		...footer,
		fixUrl: "https://app/fix/2",
	});
	expect(again.match(/Generated with/g)).toHaveLength(1);
	expect(again.match(/Fix with ytimesy/g)).toHaveLength(1);
	expect(again).toContain("https://app/fix/2");
	expect(again.indexOf("more")).toBeLessThan(again.indexOf("Generated with"));
	expect(
		withPullRequestFooter(again, { ...footer, fixUrl: "https://app/fix/2" }),
	).toBe(again);
});

it("signs without a link or mention when the pull request is not recorded", () => {
	const body = withPullRequestFooter("Adds the parser.", {});
	expect(body).toContain("Generated with ytimesy");
	expect(body).not.toContain("@");
	expect(body).not.toContain("Fix with ytimesy");
});

it("puts evidence before the footer, on first capture and on description updates", () => {
	const signed = withPullRequestFooter("Adds the parser.", footer);
	const evidence =
		"<!-- ytimesy-evidence:start sha=abc plan=p -->\nEvidence\n<!-- ytimesy-evidence:end -->";
	const withEvidence = withEvidenceSection(signed, evidence);
	expect(withEvidence.indexOf("Evidence")).toBeLessThan(
		withEvidence.indexOf("Generated with"),
	);
	const updated = descriptionKeepingEvidence(
		withEvidence,
		withPullRequestFooter("Adds the parser and a test.", footer),
	);
	expect(updated.match(/ytimesy-evidence:start/g)).toHaveLength(1);
	expect(updated.indexOf("Evidence")).toBeLessThan(
		updated.indexOf("Generated with"),
	);
});
