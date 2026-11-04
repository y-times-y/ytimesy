import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	backgroundInstallCommand,
	FRESH_INSTALL_FILES,
	freshMachineEnvironmentReport,
	freshMachineInstall,
	freshMachineNotice,
	installStatusWaitCommand,
	parseInstallStatus,
	SETUP_INSTALL_FILES,
	setupCatchUpNote,
} from "./fresh-machine-setup";

describe("freshMachineInstall", () => {
	const pnpm = ["package.json", "pnpm-lock.yaml", "README.md"];

	it("chooses the install as the build would: saved, then the repository's file, then detected", () => {
		expect(
			freshMachineInstall({
				files: pnpm,
				fileRecipe: '{"install":"make deps"}',
				savedRecipe: { install: "pnpm i" },
			}),
		).toBe("pnpm i");
		expect(
			freshMachineInstall({
				files: pnpm,
				fileRecipe: '{"install":"make deps"}',
			}),
		).toBe("make deps");
		expect(freshMachineInstall({ files: pnpm, fileRecipe: null })).toBe(
			"corepack pnpm install --frozen-lockfile",
		);
		// A saved or file setup without an install keeps Node's lockfile install.
		expect(
			freshMachineInstall({ files: pnpm, fileRecipe: null, savedRecipe: {} }),
		).toBe("corepack pnpm install --frozen-lockfile");
		expect(freshMachineInstall({ files: pnpm, fileRecipe: "{}" })).toBe(
			"corepack pnpm install --frozen-lockfile",
		);
	});

	it("falls back to detection over an invalid file, and installs nothing it does not recognize", () => {
		expect(freshMachineInstall({ files: pnpm, fileRecipe: "{not json" })).toBe(
			"corepack pnpm install --frozen-lockfile",
		);
		expect(
			freshMachineInstall({ files: ["README.md"], fileRecipe: null }),
		).toBeNull();
	});
});

describe("background installs", () => {
	function guest() {
		const home = mkdtempSync(join(tmpdir(), "fresh-machine-"));
		const repo = join(home, "app");
		execFileSync("mkdir", ["-p", repo]);
		// Without tmux the launch detaches with nohup; tests force that path.
		const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };
		const run = (command: string) =>
			execFileSync("/bin/bash", ["-c", command], { env, encoding: "utf8" });
		return { home, repo, run };
	}

	it("runs every repository's install detached, then writes the first failing exit code", () => {
		const { home, repo, run } = guest();
		const command = backgroundInstallCommand({
			installs: [
				{ directory: repo, install: "echo one > installed.txt; exit 3" },
				{ directory: repo, install: "echo two >> installed.txt" },
			],
			files: FRESH_INSTALL_FILES,
			prelude: "true",
			terminal: "ytimesy-install-test",
		});
		expect(run(command).trim()).toBe("started");
		const status = run(installStatusWaitCommand(FRESH_INSTALL_FILES, 20));
		expect(parseInstallStatus(status)).toEqual({ state: "done", exitCode: 3 });
		// A failure does not stop the next repository.
		expect(readFileSync(join(repo, "installed.txt"), "utf8")).toBe(
			"one\ntwo\n",
		);
		expect(readFileSync(join(home, FRESH_INSTALL_FILES.log), "utf8")).toContain(
			"echo one",
		);
	}, 30_000);

	it("waits for the boot's install before the setup's own runs", () => {
		const { home, repo, run } = guest();
		// The boot's install started (its log exists) and has not finished.
		run(`mkdir -p "$HOME/.ytimesy"; : > "$HOME/${FRESH_INSTALL_FILES.log}"`);
		run(
			backgroundInstallCommand({
				installs: [{ directory: repo, install: "echo setup > setup.txt" }],
				files: SETUP_INSTALL_FILES,
				prelude: "true",
				after: FRESH_INSTALL_FILES,
				terminal: "ytimesy-setup-install-test",
			}),
		);
		expect(
			parseInstallStatus(run(installStatusWaitCommand(SETUP_INSTALL_FILES, 0))),
		).toEqual({ state: "running" });
		writeFileSync(join(home, FRESH_INSTALL_FILES.status), "exit 0\n");
		expect(
			parseInstallStatus(
				run(installStatusWaitCommand(SETUP_INSTALL_FILES, 20)),
			),
		).toEqual({ state: "done", exitCode: 0 });
		expect(readFileSync(join(repo, "setup.txt"), "utf8")).toBe("setup\n");
	}, 30_000);

	it("reads a status that is not there yet as running", () => {
		expect(parseInstallStatus("running\n")).toEqual({ state: "running" });
		expect(parseInstallStatus("exit 0\n")).toEqual({
			state: "done",
			exitCode: 0,
		});
	});
});

describe("setupCatchUpNote", () => {
	const repositories = [
		{
			fullName: "acme/web",
			recipe: {
				install: "corepack pnpm install --frozen-lockfile",
				services: [
					{ name: "web", command: "pnpm dev", port: 3000, timeoutSeconds: 60 },
				],
				unverified: [
					{ what: "Dev server", reason: "Needs the realtime secret to start." },
				],
			},
		},
	];

	it("says the setup finished, what was installed, the services and what is unverified", () => {
		const note = setupCatchUpNote({
			repositories,
			install: { state: "done", exitCode: 0 },
		});
		expect(note).toContain("setup finished");
		expect(note).toContain(
			"`corepack pnpm install --frozen-lockfile`) ran on this machine and passed",
		);
		expect(note).toContain("web (`pnpm dev`, port 3000)");
		expect(note).toContain(
			"Left unverified: Dev server (Needs the realtime secret to start.)",
		);
	});

	it("says when the install failed or still runs, and the chat continues", () => {
		const failed = setupCatchUpNote({
			repositories,
			install: { state: "done", exitCode: 1 },
		});
		expect(failed).toContain(
			"failed (exit 1; log: ~/.ytimesy/setup-install.log)",
		);
		expect(failed).toContain("Continue your task.");
		expect(
			setupCatchUpNote({ repositories, install: { state: "running" } }),
		).toContain("still running on this machine");
		expect(
			setupCatchUpNote({
				repositories,
				install: { state: "failed-to-start", reason: "machine asleep" },
			}),
		).toContain("could not be run on this machine (machine asleep)");
		expect(
			setupCatchUpNote({
				repositories: [{ fullName: "acme/web", recipe: { services: [] } }],
				install: { state: "none" },
			}),
		).toContain("nothing was installed here");
	});
});

it("tells a fresh machine's agent where the install log is and that it may install itself", () => {
	const notice = freshMachineNotice();
	expect(notice).toContain("~/.ytimesy/install.log");
	expect(notice).toContain("install what you need yourself");
	expect(
		freshMachineEnvironmentReport([
			{ fullName: "acme/web", directory: "/home/ubuntu/web", install: null },
		]),
	).toMatchObject({
		notice,
		repositories: [{ fullName: "acme/web", recipe: {} }],
	});
});
