import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	preparedCheckoutFromReuse,
	preparedCheckoutPathFromReuse,
	reusePreparedCheckoutCommand,
} from "./clone-project";

it("finds a prepared checkout without network access or credentials", () => {
	const script = reusePreparedCheckoutCommand("ytimesy");
	expect(script).toContain('if [ -d "$DEST/.git" ]; then');
	expect(script).not.toContain("git clone");
	expect(preparedCheckoutPathFromReuse("present\n/home/ubuntu/ytimesy\n")).toBe(
		"/home/ubuntu/ytimesy",
	);
	expect(preparedCheckoutPathFromReuse("absent")).toBeNull();
});

it("reads the checkout's branch and path note in the same command", () => {
	const home = mkdtempSync(join(tmpdir(), "reuse-"));
	try {
		execFileSync("git", [
			"init",
			"-q",
			"-b",
			"ytimesy/chat-1",
			join(home, "app"),
		]);
		const stdout = execFileSync(
			"sh",
			["-c", reusePreparedCheckoutCommand("app")],
			{
				env: { PATH: process.env.PATH, HOME: home },
				encoding: "utf8",
			},
		);
		const found = preparedCheckoutFromReuse(stdout);
		expect(found).toMatchObject({
			path: join(home, "app"),
			branch: "ytimesy/chat-1",
		});
		expect(typeof found?.cwdNote).toBe("string");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
	expect(
		preparedCheckoutFromReuse(
			"present\n/home/u/app\nbranch:\ncwd:/home/u/app\n",
		),
	).toEqual({ path: "/home/u/app", branch: "", cwdNote: "/home/u/app" });
	expect(preparedCheckoutFromReuse("present\n/home/u/app\n")).toEqual({
		path: "/home/u/app",
		branch: undefined,
		cwdNote: undefined,
	});
});
