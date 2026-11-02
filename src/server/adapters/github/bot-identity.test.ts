import { afterEach, expect, it, vi } from "vitest";
import { resolveGithubAppBot } from "./bot-identity";

afterEach(() => vi.restoreAllMocks());

it("uses the configured bot id without any GitHub call", async () => {
	const lookup = vi.fn();
	const fetchSpy = vi.spyOn(globalThis, "fetch");
	await expect(
		resolveGithubAppBot({
			env: {
				GITHUB_APP_SLUG: "ytimesy-agent",
				GITHUB_APP_BOT_USER_ID: "328807657",
			},
			installationId: 1,
			lookup,
		}),
	).resolves.toEqual({
		name: "ytimesy-agent[bot]",
		email: "328807657+ytimesy-agent[bot]@users.noreply.github.com",
	});
	expect(lookup).not.toHaveBeenCalled();
	expect(fetchSpy).not.toHaveBeenCalled();
});

it("warns and looks the bot up with the App's installation when the id is not configured", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	const lookup = vi.fn(async () => 99);
	const bot = await resolveGithubAppBot({
		env: { GITHUB_APP_SLUG: "fallback-app" },
		installationId: 7,
		repositoryName: "web",
		lookup,
	});
	expect(lookup).toHaveBeenCalledWith({
		slug: "fallback-app",
		installationId: 7,
		repositoryName: "web",
	});
	expect(bot).toEqual({
		name: "fallback-app[bot]",
		email: "99+fallback-app[bot]@users.noreply.github.com",
	});
	expect(warn).toHaveBeenCalledWith(
		expect.stringContaining("GITHUB_APP_BOT_USER_ID is not set"),
	);
});

it("logs, never silently drops, a failed lookup", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
	await expect(
		resolveGithubAppBot({
			env: { GITHUB_APP_SLUG: "failing-app" },
			installationId: 7,
			lookup: async () => {
				throw new Error("GitHub answered 403.");
			},
		}),
	).resolves.toBeNull();
	expect(warn).toHaveBeenCalledWith(
		expect.stringContaining("could not be looked up"),
		{ message: "GitHub answered 403." },
	);
});
