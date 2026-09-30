import { expect, it } from "vitest";
import {
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
