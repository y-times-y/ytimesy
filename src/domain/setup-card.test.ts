import { expect, it } from "vitest";
import { GITHUB_SETUP_MESSAGE } from "./github-sign-in";
import { setupCard } from "./setup-card";

const failedBuild = {
	status: "failed" as const,
	rebuild: false,
	errorMessage: "boom",
	failure: {
		command: "pnpm install",
		exitCode: 1,
		step: "Installing dependencies",
		output: "ERR_PNPM",
	} as never,
};

it("queued and building show a calm progress state, not an error", () => {
	expect(setupCard({ status: "queued" })).toMatchObject({
		state: "queued",
		tone: "calm",
		title: "Getting ready to set up",
		progress: "queued",
	});
	expect(setupCard({ status: "cloning" })).toMatchObject({
		state: "building",
		tone: "calm",
		reason: "Cloning the repository",
		progress: "building",
	});
});

it("a failed build says which command failed, from the real failure", () => {
	const card = setupCard({
		status: "failed",
		errorMessage: "x",
		build: failedBuild,
	});
	expect(card.state).toBe("failed");
	expect(card.tone).toBe("failure");
	expect(card.title).toBe("Setup didn't finish");
	expect(card.reason).toBe(
		"Installing dependencies: pnpm install failed (exit 1)",
	);
	expect(card.hasDetails).toBe(true);
});

it("a failure without a build uses the stored message, else a plain line", () => {
	expect(
		setupCard({ status: "failed", errorMessage: "Repository not found." })
			.reason,
	).toBe("Repository not found.");
	expect(setupCard({ status: "failed", errorMessage: null }).reason).toBe(
		"Setup stopped before it finished.",
	);
});

it("a missing GitHub link needs the person, in the neutral style", () => {
	const card = setupCard({
		status: "failed",
		errorMessage: GITHUB_SETUP_MESSAGE,
	});
	expect(card).toMatchObject({
		state: "needs-github",
		tone: "needs-you",
		title: "Connect GitHub to continue",
	});
});

it("a setup that never started is a nudge, not an alarm", () => {
	expect(setupCard({ status: "queued", stalled: true })).toMatchObject({
		state: "failed",
		tone: "needs-you",
		reason: "Setup hasn't started yet.",
	});
});

it("retrying wins over the failure it follows", () => {
	expect(
		setupCard({ status: "failed", errorMessage: "x", retrying: true }),
	).toMatchObject({ state: "retrying", tone: "calm", progress: "queued" });
});

it("ready, and a rebuild that runs while ready", () => {
	expect(setupCard({ status: "ready" })).toMatchObject({
		state: "ready",
		progress: "ready",
	});
	expect(
		setupCard({
			status: "ready",
			build: {
				status: "running",
				rebuild: true,
				errorMessage: null,
				failure: null,
			},
		}),
	).toMatchObject({ state: "building", title: "Updating the environment" });
});
