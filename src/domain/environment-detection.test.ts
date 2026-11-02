import { expect, it } from "vitest";
import {
	detectEnvironment,
	detectedSetupLine,
	environmentSetupNotice,
	offersEnvironmentSetup,
	type RepositorySetup,
} from "./environment-detection";
import { environmentRecipe } from "./project-environment";

it("detects Node installs and their checks from the lockfile and scripts", () => {
	expect(
		detectEnvironment(["package.json", "pnpm-lock.yaml"], {
			build: "vite build",
			test: "vitest",
			lint: "biome",
		}),
	).toEqual({
		label: "Node (pnpm)",
		install: "corepack pnpm install --frozen-lockfile",
		checks: ["corepack pnpm run build", "corepack pnpm run test"],
	});
	expect(detectEnvironment(["package.json", "package-lock.json"]).install).toBe(
		"npm ci",
	);
	expect(detectEnvironment(["package.json"]).install).toBe("npm install");
	expect(detectEnvironment(["package.json", "yarn.lock"]).label).toBe(
		"Node (yarn)",
	);
});

it("detects Python, Go and Rust installs, preferring the lockfile", () => {
	expect(detectEnvironment(["pyproject.toml", "uv.lock"])).toMatchObject({
		label: "Python (uv)",
		install: expect.stringContaining("uv sync --frozen"),
	});
	expect(
		detectEnvironment(["pyproject.toml", "poetry.lock"]).install,
	).toContain("poetry install");
	expect(detectEnvironment(["requirements.txt"]).install).toContain(
		"pip install --quiet -r requirements.txt",
	);
	expect(detectEnvironment(["go.mod", "go.sum"])).toMatchObject({
		label: "Go",
		install: "go mod download",
	});
	expect(detectEnvironment(["Cargo.toml"])).toMatchObject({
		label: "Rust",
		install: "cargo fetch",
	});
});

it("recognizes nothing in a repository without a manifest, and a recipe from it is valid", () => {
	const detected = detectEnvironment(["README.md", "docs", "main.c"]);
	expect(detected).toEqual({ label: null, checks: [] });
	expect(
		environmentRecipe.safeParse({ checks: [...detected.checks] }).success,
	).toBe(true);
});

const repo = (setup: Partial<RepositorySetup>): RepositorySetup => ({
	repositoryId: 1,
	fullName: "org/app",
	source: "none",
	...setup,
});

it("tells the agent to install what it needs only when no setup was verified", () => {
	expect(
		environmentSetupNotice([
			repo({ source: "saved" }),
			repo({ source: "file" }),
		]),
	).toBeNull();
	expect(
		environmentSetupNotice([repo({ source: "detected", install: "npm ci" })]),
	).toBeNull();
	const none = environmentSetupNotice([repo({ source: "none" })]);
	expect(none).toContain("org/app: no saved environment setup");
	expect(none).toContain("Install what this task needs yourself");
	expect(none).toContain("Set up environment");
	expect(environmentSetupNotice([repo({ source: "plain" })])).toContain(
		"setup was skipped",
	);
	expect(
		environmentSetupNotice([
			repo({
				source: "detected",
				installFailure: { command: "uv sync", exitCode: 2, output: "" },
			}),
		]),
	).toContain("`uv sync` failed (exit 2)");
});

it("says in Settings what the active build actually detected", () => {
	expect(detectedSetupLine(null)).toBe("Not set up yet.");
	expect(detectedSetupLine(repo({ source: "file" }))).toContain(
		".ytimesy/environment.json",
	);
	expect(detectedSetupLine(repo({ source: "none" }))).toContain(
		"nothing detected",
	);
	expect(
		detectedSetupLine(
			repo({ source: "detected", detected: "Go", install: "go mod download" }),
		),
	).toBe("Not set up yet: Go, installs with go mod download.");
	expect(
		detectedSetupLine(
			repo({
				source: "detected",
				detected: "Rust",
				installFailure: { command: "cargo fetch", exitCode: 101, output: "" },
			}),
		),
	).toBe("Not set up yet: Rust install failed (exit 101).");
});

it("offers Set up environment until a repository has a saved or committed setup", () => {
	expect(offersEnvironmentSetup([{ saved: null, setup: null }])).toBe(true);
	expect(
		offersEnvironmentSetup([{ saved: null, setup: { source: "detected" } }]),
	).toBe(true);
	expect(
		offersEnvironmentSetup([{ saved: null, setup: { source: "file" } }]),
	).toBe(false);
	expect(offersEnvironmentSetup([{ saved: { id: "x" }, setup: null }])).toBe(
		false,
	);
});
