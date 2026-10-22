import { expect, it } from "vitest";
import { runDetachedCommand } from "./detached-command";

it("keeps umask 077 to the secret script, not the detached command itself", async () => {
	const commands: string[] = [];
	await runDetachedCommand(
		async (command) => {
			commands.push(command);
			return {
				exitCode: 0,
				stdout: commands.length === 1 ? "1700000000" : "0",
				stderr: "",
			};
		},
		"0123456789abcdef",
		["git", "checkout", "main"],
		{ TOKEN: "x" },
		60_000,
		Date.now() + 60_000,
	);
	const start = commands[0] ?? "";
	// Setup under umask 077 left the checkout 0600 and a read-only helper
	// (another Linux user) could read none of it.
	expect(start).toMatch(
		/\(umask 077; mkdir -p "\$d" && printf '%s' \S+ \| base64 -d >"\$d\/run\.sh"\) \|\| exit 1; setsid /,
	);
	expect(start.match(/umask/g)).toHaveLength(1);
});
