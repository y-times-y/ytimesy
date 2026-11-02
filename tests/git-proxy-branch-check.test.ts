import { expect, it, vi } from "vitest";
import { checkBranchNames } from "../src/server/adapters/github/git-proxy-transfer";

function host(result: { exitCode: number; stderr: string }) {
	return {
		exec: vi.fn(async (_command: string, _timeoutMs: number) => ({
			stdout: "",
			...result,
		})),
		writeTextFile: async () => {},
	};
}

it("passes valid branch names", async () => {
	const ok = host({ exitCode: 0, stderr: "" });
	await expect(
		checkBranchNames(ok, ["main", "ytimesy/token-test-1"]),
	).resolves.toBeUndefined();
	expect(ok.exec.mock.calls[0]?.[0]).toBe(
		"git check-ref-format --branch 'main' && git check-ref-format --branch 'ytimesy/token-test-1'",
	);
});

it("rejects a name only when Git says it is not valid", async () => {
	await expect(
		checkBranchNames(
			host({
				exitCode: 128,
				stderr: "fatal: 'a..b' is not a valid branch name",
			}),
			["a..b"],
		),
	).rejects.toThrow("Workspace Git rejected the branch name.");
});

it("reports a command that could not run with its exit code and a redacted cause", async () => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const failure = checkBranchNames(
		host({
			exitCode: 128,
			stderr:
				"fatal: detected dubious ownership in repository at '/workspace' https://x-access-token:ghs_abcdefghij1234@github.com/a/b",
		}),
		["ytimesy/token-test-1"],
	);
	await expect(failure).rejects.toThrow(
		/^Workspace Git could not check the branch name \(exit 128: fatal: detected dubious ownership/,
	);
	await expect(failure).rejects.not.toThrow(/ghs_|rejected the branch name/);
	await expect(
		checkBranchNames(host({ exitCode: 124, stderr: "" }), ["main"]),
	).rejects.toThrow(
		"Workspace Git could not check the branch name (exit 124).",
	);
});
