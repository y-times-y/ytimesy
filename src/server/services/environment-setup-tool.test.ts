import { beforeEach, expect, it, vi } from "vitest";

const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("./project-environment-setup", () => ({
	saveProjectEnvironment: save,
}));

import {
	environmentSetupTools,
	SAVE_PROJECT_ENVIRONMENT_TOOL,
} from "./environment-setup-tool";

const run = (input: Record<string, unknown>) =>
	(
		environmentSetupTools({ userId: "u1", projectId: "p1" })[
			SAVE_PROJECT_ENVIRONMENT_TOOL
		] as { execute: (input: unknown, options: unknown) => Promise<unknown> }
	).execute(input, {});

beforeEach(() => save.mockReset());

it("saves a verified setup as the agent's, and says the image rebuilds", async () => {
	save.mockResolvedValue({ repository: "you/web", rebuilding: true });
	const result = await run({
		install: "corepack pnpm install --frozen-lockfile",
		services: [{ name: "web", command: "pnpm dev", port: 3000 }],
		checks: ["pnpm test"],
		summary: "Installs with pnpm and starts the dev server.",
	});
	expect(save).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: "u1",
			projectId: "p1",
			source: "agent",
			recipe: expect.objectContaining({
				install: "corepack pnpm install --frozen-lockfile",
				services: [expect.objectContaining({ name: "web", port: 3000 })],
				checks: ["pnpm test"],
			}),
		}),
	);
	expect(result).toMatchObject({ saved: true, repository: "you/web" });
});

it("refuses an invalid setup without saving it", async () => {
	const result = await run({
		services: [{ name: "web", command: "pnpm dev", port: 80 }],
		summary: "x",
	});
	expect(save).not.toHaveBeenCalled();
	expect(result).toMatchObject({ saved: false });
});

it("saves a partly verified setup with what it could not verify", async () => {
	save.mockResolvedValue({ repository: "you/web", rebuilding: true });
	const result = await run({
		install: "pnpm install --frozen-lockfile",
		checks: ["pnpm build", "pnpm typecheck"],
		unverified: [
			{
				what: "Dev server",
				reason: "Needs the realtime secret to start.",
				secrets: ["REALTIME_SECRET"],
			},
		],
		summary: "Installs, builds and typechecks with pnpm.",
	});
	expect(result).toMatchObject({ saved: true });
	expect(save).toHaveBeenCalledWith(
		expect.objectContaining({
			recipe: expect.objectContaining({
				checks: ["pnpm build", "pnpm typecheck"],
				unverified: [
					{
						what: "Dev server",
						reason: "Needs the realtime secret to start.",
						secrets: ["REALTIME_SECRET"],
					},
				],
			}),
		}),
	);
});

it("tells the agent not to hold the save back for optional runtime pieces", () => {
	const saveTool = environmentSetupTools({ userId: "u1", projectId: "p1" })[
		SAVE_PROJECT_ENVIRONMENT_TOOL
	] as {
		description: string;
		inputSchema: { safeParse: (v: unknown) => { success: boolean } };
	};
	expect(saveTool.description).toMatch(/Do not hold the save back/);
	expect(saveTool.description).toMatch(/unverified/);
	expect(
		saveTool.inputSchema.safeParse({
			summary: "x",
			unverified: [{ what: "Dev server", reason: "Needs a secret." }],
		}).success,
	).toBe(true);
});
