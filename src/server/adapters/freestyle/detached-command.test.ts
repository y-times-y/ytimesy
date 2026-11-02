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

it("reports a watched command's output tail while it runs, polling faster", async () => {
	const { withCommandOutput } = await import("../command-output");
	const tails: string[] = [];
	const sleeps: number[] = [];
	let polls = 0;
	const result = await withCommandOutput(
		(tail) => {
			tails.push(tail);
		},
		() =>
			runDetachedCommand(
				async (command) => {
					if (command.includes("run.sh"))
						return ok(String(Math.floor(Date.now() / 1000)));
					polls += 1;
					if (command.startsWith("tail -c")) return ok("final output");
					const marker = "\n--ytimesy-output--\n";
					return polls === 1
						? ok(`${marker}installing 1/3`)
						: polls === 2
							? ok(`${marker}installing 1/3`)
							: ok(`0${marker}installing 3/3`);
				},
				"0123456789abcdef",
				["npm", "ci"],
				{},
				60_000,
				Date.now() + 60_000,
				async (ms) => {
					sleeps.push(ms);
				},
			),
	);
	expect(result).toEqual({ exitCode: 0, stdout: "final output", stderr: "" });
	// Unchanged output is not reported again.
	expect(tails).toEqual(["installing 1/3", "installing 3/3"]);
	// The first reads come quickly: a short command is not held for a full poll.
	expect(sleeps).toEqual([250, 500]);
});

it("reads a short command's status within a second, then backs off to the poll interval", async () => {
	const { detachedPollDelay } = await import("./detached-command");
	expect(
		[0, 1, 2, 3, 4].map((polls) => detachedPollDelay(polls, false)),
	).toEqual([250, 500, 1_000, 5_000, 5_000]);
	expect([0, 1, 2, 3].map((polls) => detachedPollDelay(polls, true))).toEqual([
		250, 500, 1_000, 2_000,
	]);
});

function ok(stdout: string) {
	return { exitCode: 0, stdout, stderr: "" };
}
