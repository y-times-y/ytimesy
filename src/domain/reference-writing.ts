/**
 * How an agent writes a pull request or an issue in a reply. GitHub numbers
 * issues and pull requests together, so a bare "#12" does not say which it
 * is; the chat looks the type up and shows a neutral chip until it knows.
 * Written by the agent, the type is never a guess.
 */
export const REFERENCE_WRITING_RULE =
	"Write a pull request as pr:owner/repo#123 and an issue as issue:owner/repo#123, with the repository's full name, so each shows with the right icon. Never write a bare #123 for either (GitHub numbers them together, so the number alone does not say which it is) and never guess the type: when you do not know it, read it from GitHub first.";
