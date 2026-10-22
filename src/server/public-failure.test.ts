import { afterEach, expect, it, vi } from "vitest";
import {
	publicRecoveryFailure,
	RecoveryRefused,
} from "#/domain/conversation-recovery-failure";
import { withPublicFailure } from "./public-failure";

afterEach(() => vi.restoreAllMocks());

it("shows the user a short safe line and logs the real error on the server", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const internal = new Error(
		"VM usage owner could not be uniquely verified. token ghp_abcdef123456",
	);
	const failure = withPublicFailure(
		"Conversation recovery",
		(error) => publicRecoveryFailure(error, "fork"),
		async () => {
			throw internal;
		},
	);
	await expect(failure).rejects.toThrow(
		/^Couldn't fork this chat\. Try again\.$/,
	);
	expect(log).toHaveBeenCalledTimes(1);
	const logged = JSON.stringify(log.mock.calls[0]);
	expect(logged).toContain("could not be uniquely verified");
	expect(logged).not.toContain("ghp_abcdef123456");
});

it("passes a refusal the user can act on through as written", async () => {
	vi.spyOn(console, "error").mockImplementation(() => {});
	await expect(
		withPublicFailure(
			"Conversation recovery",
			(error) => publicRecoveryFailure(error, "both"),
			async () => {
				throw new RecoveryRefused(
					"Stop the active turn before using recovery.",
				);
			},
		),
	).rejects.toThrow("Stop the active turn before using recovery.");
	expect(publicRecoveryFailure(new Error("pg: relation missing"), "both")).toBe(
		"Couldn't restore this point. Try again.",
	);
	expect(
		await withPublicFailure(
			"x",
			() => "unused",
			async () => 42,
		),
	).toBe(42);
});
