import { expect, it } from "vitest";
import { newImportCode } from "./local-import";
import { localImportCommand, localImportPrompt } from "./local-import-prompt";

it("carries the code in the command the local agent runs", () => {
	const code = newImportCode();
	const prompt = localImportPrompt(code);
	expect(localImportCommand(code)).toBe(
		`npx -y ytimesy continue --code ${code}`,
	);
	expect(prompt).toContain(localImportCommand(code));
	expect(prompt.split(code)).toHaveLength(2);
	expect(prompt).toContain("expires in 15 minutes");
});

it("states what the agent must and must not do", () => {
	const prompt = localImportPrompt("YTM-AAAA-BBBB-CCCC");
	for (const rule of [
		"this session, all sessions for this project, or everything on this machine",
		"Show me the plan the CLI prints",
		"Never open, print or read .env files yourself",
		"ask me which ones the cloud agent needs",
		"before pushing anything from a repository other than this one",
		"before creating a new repository",
		"That first run only plans",
		"then run the command it prints",
		"untracked files the CLI lists (--yes-untracked)",
		"In a public repository, ask before pushing any untracked file (--yes-public)",
		"list the files pushed and anything skipped",
		"run that command with --cancel",
		'"Done — open <link>"',
	])
		expect(prompt).toContain(rule);
});

it("stays short enough to paste comfortably", () => {
	const prompt = localImportPrompt("YTM-AAAA-BBBB-CCCC");
	expect(prompt.length).toBeLessThan(1200);
	expect(prompt.split("\n").length).toBeLessThanOrEqual(14);
});
