import { execFile } from "node:child_process";
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	DEPENDENCY_CACHE_ROOT,
	DEPENDENCY_CACHE_URL_VARIABLE,
	dependencyCacheSpec,
	dependencyInputsHashCommand,
	dependencyRestoreCommand,
	dependencyUploadCommand,
	dependencyUploadsSettledCommand,
} from "./dependency-cache";

const run = promisify(execFile);

it("caches only the install a lockfile implies", () => {
	expect(
		dependencyCacheSpec(["package.json", "package-lock.json"], "npm ci"),
	).toMatchObject({
		stack: "npm",
		afterRestore: "skip",
	});
	expect(
		dependencyCacheSpec(
			["package.json", "pnpm-lock.yaml"],
			"corepack pnpm install --frozen-lockfile",
		)?.stack,
	).toBe("pnpm");
	expect(
		dependencyCacheSpec(
			["package.json", "yarn.lock"],
			"corepack yarn install --frozen-lockfile",
		)?.stack,
	).toBe("yarn");
	// No lockfile: not reproducible.
	expect(dependencyCacheSpec(["package.json"], "npm install")).toBeNull();
	// A custom install may do anything.
	expect(
		dependencyCacheSpec(["package.json", "package-lock.json"], "make deps"),
	).toBeNull();
	expect(
		dependencyCacheSpec(
			["requirements.txt"],
			"python3 -m venv .venv && .venv/bin/python -m pip install --quiet -r requirements.txt",
		)?.stack,
	).toBe("pip");
	expect(
		dependencyCacheSpec(
			["uv.lock", "pyproject.toml"],
			"command -v uv >/dev/null 2>&1 || python3 -m pip install --user --quiet uv; uv sync --frozen",
		),
	).toMatchObject({ stack: "uv", afterRestore: "install" });
	expect(
		dependencyCacheSpec(
			["poetry.lock", "pyproject.toml"],
			"command -v poetry >/dev/null 2>&1 || python3 -m pip install --user --quiet poetry; poetry install --no-interaction --no-root",
		),
	).toMatchObject({ stack: "poetry", afterRestore: "install" });
	expect(
		dependencyCacheSpec(["go.mod", "go.sum"], "go mod download")?.stack,
	).toBe("go");
	expect(dependencyCacheSpec(["go.mod"], "go mod download")).toBeNull();
	expect(
		dependencyCacheSpec(["Cargo.toml", "Cargo.lock"], "cargo fetch")?.stack,
	).toBe("cargo");
	expect(dependencyCacheSpec(["Cargo.toml"], "cargo fetch")).toBeNull();
	expect(dependencyCacheSpec(["README.md"], undefined)).toBeNull();
});

let root: string;
let checkout: string;
let bin: string;
let server: Server;
let base: string;
const objects = new Map<string, Buffer>();

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "ytimesy-dependency-cache-"));
	checkout = join(root, "app");
	bin = join(root, "bin");
	await mkdir(join(checkout, "node_modules/left-pad"), { recursive: true });
	await mkdir(join(checkout, "packages/ui/node_modules/tiny"), {
		recursive: true,
	});
	await writeFile(join(checkout, "package.json"), '{"name":"app"}');
	await writeFile(join(checkout, "package-lock.json"), '{"lockfileVersion":3}');
	await writeFile(join(checkout, "packages/ui/package.json"), '{"name":"ui"}');
	await writeFile(
		join(checkout, "node_modules/left-pad/index.js"),
		"module.exports=1",
	);
	await writeFile(
		join(checkout, "node_modules/.npmrc"),
		"//registry/:_authToken=secret",
	);
	await writeFile(
		join(checkout, "packages/ui/node_modules/tiny/index.js"),
		"2",
	);
	// This machine has no setsid; the guest's does what this shim does here.
	await mkdir(bin);
	await writeFile(join(bin, "setsid"), '#!/bin/sh\nexec "$@"\n');
	await chmod(join(bin, "setsid"), 0o755);
	objects.clear();
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			if (request.method === "PUT") {
				objects.set(request.url ?? "", Buffer.concat(chunks));
				if (request.url?.includes("slow"))
					setTimeout(() => response.end(), 1500);
				else response.end();
				return;
			}
			const stored = objects.get(request.url ?? "");
			response.statusCode = stored ? 200 : 404;
			response.end(stored);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	await rm(root, { recursive: true, force: true });
	await rm(DEPENDENCY_CACHE_ROOT, { recursive: true, force: true });
});

async function bash(command: string, env: Record<string, string> = {}) {
	try {
		const { stdout } = await run("bash", ["-c", command], {
			env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, ...env },
		});
		return { exitCode: 0, stdout };
	} catch (error) {
		const failed = error as { code?: number; stdout?: string };
		return { exitCode: failed.code ?? 1, stdout: failed.stdout ?? "" };
	}
}

const spec = () => {
	const found = dependencyCacheSpec(
		["package.json", "package-lock.json"],
		"npm ci",
	);
	if (!found) throw new Error("no spec");
	return found;
};

it("keys on every manifest and lockfile, not on installed files", async () => {
	const hash = async () =>
		(await bash(dependencyInputsHashCommand(checkout, spec()))).stdout.trim();
	const first = await hash();
	expect(first).toMatch(/^[a-f0-9]{64}$/);
	await writeFile(join(checkout, "node_modules/left-pad/package.json"), "{}");
	expect(await hash()).toBe(first);
	await writeFile(
		join(checkout, "packages/ui/package.json"),
		'{"name":"ui","version":"2"}',
	);
	const second = await hash();
	expect(second).not.toBe(first);
	await writeFile(
		join(checkout, "package-lock.json"),
		'{"lockfileVersion":3,"x":1}',
	);
	expect(await hash()).not.toBe(second);
	// npm ci would run the project's own install scripts; a restore cannot.
	await writeFile(
		join(checkout, "package.json"),
		'{"scripts":{"postinstall":"node gen.js"}}',
	);
	expect((await hash()).trim()).toBe("lifecycle");
});

it("stores what install produced in the background, then restores it in place", async () => {
	const url = `${base}/cache/key.tar`;
	const miss = await bash(dependencyRestoreCommand(), {
		[DEPENDENCY_CACHE_URL_VARIABLE]: url,
	});
	expect(miss.exitCode).toBe(3);
	const started = await bash(
		dependencyUploadCommand(checkout, spec(), "a".repeat(32)),
		{
			[DEPENDENCY_CACHE_URL_VARIABLE]: url,
		},
	);
	expect(started.stdout.trim()).toBe("started");
	expect((await bash(dependencyUploadsSettledCommand(20))).exitCode).toBe(0);
	expect(objects.get("/cache/key.tar")?.length).toBeGreaterThan(0);
	await rm(join(checkout, "node_modules"), { recursive: true });
	await rm(join(checkout, "packages/ui/node_modules"), { recursive: true });
	const hit = await bash(dependencyRestoreCommand(), {
		[DEPENDENCY_CACHE_URL_VARIABLE]: url,
	});
	expect(hit.exitCode).toBe(0);
	expect(
		await readFile(join(checkout, "node_modules/left-pad/index.js"), "utf8"),
	).toBe("module.exports=1");
	expect(
		await readFile(
			join(checkout, "packages/ui/node_modules/tiny/index.js"),
			"utf8",
		),
	).toBe("2");
	// Credential files never enter the archive.
	await expect(
		readFile(join(checkout, "node_modules/.npmrc"), "utf8"),
	).rejects.toThrow();
});

it("returns as soon as the upload started, without waiting for it", async () => {
	const url = `${base}/cache/slow.tar`;
	const started = Date.now();
	const result = await bash(
		dependencyUploadCommand(checkout, spec(), "b".repeat(32)),
		{ [DEPENDENCY_CACHE_URL_VARIABLE]: url },
	);
	expect(result.stdout.trim()).toBe("started");
	expect(Date.now() - started).toBeLessThan(1000);
	expect((await bash(dependencyUploadsSettledCommand(20))).exitCode).toBe(0);
	expect(objects.has("/cache/slow.tar")).toBe(true);
});
