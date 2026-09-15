import { describe, expect, it } from "vitest";
import {
	cloneSelectedProjectScript,
	PROJECT_CWD_PATH,
	preparedCheckoutPathFromReuse,
	pushSelectedBranchScript,
	redactInstallationToken,
	reusePreparedCheckoutCommand,
} from "./clone-project";

describe("cloneSelectedProjectScript", () => {
	it("clones the selected branch and forgets the installation token in the remote URL", () => {
		const script = cloneSelectedProjectScript({
			owner: "y-times-y",
			name: "ytimesy",
			branch: "master",
			destination: "/home/ubuntu/ytimesy",
		});
		expect(script).toContain("git clone --depth 1 --branch");
		expect(script).toContain("x-access-token:");
		expect(script).toContain("@github.com");
		expect(script).toContain('if [ -d "$DEST/.git" ]; then');
		expect(script).not.toContain('git -C "$DEST" fetch --depth 1');
		expect(script).toContain('git -C "$DEST" remote set-url origin');
		expect(script).toContain(PROJECT_CWD_PATH);
		expect(script).toContain('rm -f "$TOKEN_FILE"');
		expect(script).not.toContain("ghs_");
	});

	it("redacts installation tokens from clone logs", () => {
		expect(
			redactInstallationToken(
				"fatal: https://x-access-token:ghs_secret@github.com/y-times-y/ytimesy.git",
			),
		).toBe(
			"fatal: https://x-access-token:***@github.com/y-times-y/ytimesy.git",
		);
	});

	it("reuses a sealed checkout without cloning again", () => {
		const script = reusePreparedCheckoutCommand("ytimesy");
		expect(script).toContain('if [ -d "$DEST/.git" ]; then');
		expect(script).toContain(PROJECT_CWD_PATH);
		expect(script).not.toContain("git clone");
		expect(
			preparedCheckoutPathFromReuse("present\n/home/ubuntu/ytimesy\n"),
		).toBe("/home/ubuntu/ytimesy");
		expect(preparedCheckoutPathFromReuse("absent")).toBeNull();
	});

	it("pushes HEAD with the installation token, then forgets it on origin", () => {
		const script = pushSelectedBranchScript({
			owner: "y-times-y",
			name: "ytimesy",
			branch: "ytimesy-abc",
			directory: "/home/ubuntu/ytimesy",
		});
		expect(script).toContain('git -C "$DEST" push -u');
		expect(script).toContain("HEAD:");
		expect(script).toContain('rm -f "$TOKEN_FILE"');
		expect(script).not.toContain("ghs_");
	});
});
