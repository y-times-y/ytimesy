import { expect, it } from "vitest";
import { apiModelFailureMessage } from "../src/domain/api-turn-failure";

it("explains a dirty checkout instead of blaming the model provider", () => {
	expect(
		apiModelFailureMessage(
			new Error(
				"(FiberFailure) Error: Commit or stash this chat's uncommitted changes before switching branches.",
			),
		),
	).toContain("The workspace could not be prepared");
});
