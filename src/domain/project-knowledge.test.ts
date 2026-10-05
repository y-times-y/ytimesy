import { expect, it } from "vitest";
import {
	knowledgeForTask,
	type ProjectKnowledgeEntry,
	updateProjectKnowledge,
} from "./project-knowledge";

const branch: ProjectKnowledgeEntry = {
	key: "branch-selection",
	title: "Branch selection",
	content:
		"Already implemented; inspect the current checkout before replacing it.",
	sources: ["repo/src/branch.ts"],
	status: "tested",
};

it("maintains named Markdown entries without dropping earlier capabilities", () => {
	let document = "Legacy briefing retained.";
	for (let index = 0; index < 8; index++)
		document = updateProjectKnowledge(document, {
			...branch,
			key: `feature-${index}`,
			title: `Feature ${index}`,
		});
	document = updateProjectKnowledge(document, {
		...branch,
		key: "feature-0",
		content: "Corrected implementation location.",
	});
	expect(document).toContain("Legacy briefing retained.");
	expect(document).toContain("Feature 7");
	expect(document).not.toContain("## Feature 0");
	expect(document.match(/<!-- ytimesy-knowledge:feature-0 -->/g)).toHaveLength(
		1,
	);
	expect(document).toContain("Corrected implementation location.");
});

it("gives children relevant entries without legacy briefing or unrelated context", () => {
	const document = updateProjectKnowledge(
		updateProjectKnowledge("Old sibling reply", branch),
		{
			...branch,
			key: "billing",
			title: "Billing",
			content: "Invoices",
			sources: ["billing.ts"],
		},
	);
	expect(knowledgeForTask(document, "Fix branch selection", true)).toContain(
		"repo/src/branch.ts",
	);
	expect(
		knowledgeForTask(document, "Fix branch selection", true),
	).not.toContain("Invoices");
	expect(
		knowledgeForTask(document, "Fix branch selection", true),
	).not.toContain("Old sibling reply");
	expect(knowledgeForTask(document, "Change avatar", true)).toBe("");
	expect(knowledgeForTask(document, "Change avatar", false)).toBe(document);
});

it("rejects overflow and reserved markers rather than silently truncating knowledge", () => {
	expect(() => updateProjectKnowledge("x".repeat(12000), branch)).toThrow(
		"full",
	);
	expect(() => updateProjectKnowledge("", { ...branch, key: ".*" })).toThrow(
		"key",
	);
	expect(() =>
		updateProjectKnowledge("", {
			...branch,
			content: "<!-- /ytimesy-knowledge -->",
		}),
	).toThrow("markers");
});
