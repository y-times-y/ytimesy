// Configures a checkout with the managed Git identity: the user as author, the
// ytimesy bot as Co-authored-by (commit hooks, push guard, user.name/email).
// New chats get this automatically from the user's GitHub profile; run it in a
// checkout that was set up before that (or that has only the bot identity).
//
//   node --import tsx scripts/managed-git-setup.ts <name> <id+login@users.noreply.github.com> [directory]
//
// Only a GitHub noreply address is accepted: never an invented identity.
import { execFileSync } from "node:child_process";
import { managedGitSetupCommand } from "../src/server/adapters/managed-git-identity";

const [name, email, directory = process.cwd()] = process.argv.slice(2);
if (
	!name ||
	!email ||
	!/^\d+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/.test(email)
) {
	console.error(
		"Usage: managed-git-setup.ts <name> <id+login@users.noreply.github.com> [directory]",
	);
	process.exit(2);
}
execFileSync(
	"sh",
	["-ec", managedGitSetupCommand(directory, { name, email })],
	{
		stdio: "inherit",
	},
);
console.log(`Managed Git identity set: ${name} <${email}>`);
