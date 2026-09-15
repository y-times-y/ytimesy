import { describe, expect, it } from "vitest";
import { cloneSelectedProjectScript, PROJECT_CWD_PATH } from "./clone-project";

describe("cloneSelectedProjectScript", () => {
	it("clones the selected branch and forgets the installation token in the remote URL", () => {
		const script = cloneSelectedProjectScript({
			owner: "y-times-y",
			name: "ytimesy",
			branch: "master",
			destination: "/home/ubuntu/ytimesy",
		});
		expect(script).toContain("git clone --depth 1 --branch");
		expect(script).toContain('git -C "$DEST" remote set-url origin');
		expect(script).toContain(PROJECT_CWD_PATH);
		expect(script).toContain('rm -f "$TOKEN_FILE"');
		expect(script).not.toContain("ghs_");
	});
});
