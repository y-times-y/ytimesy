import { afterEach, expect, it, vi } from "vitest";
import { receiveProxiedRepository } from "../src/server/adapters/github/git-proxy-transfer";

afterEach(() => vi.unstubAllEnvs());

it("keeps structured local inspections short while giving network Git work its full timeout", async () => {
	vi.stubEnv("YTIMESY_GIT_PROXY_URL", "https://proxy.invalid");
	vi.stubEnv("YTIMESY_GIT_PROXY_SECRET", "f".repeat(64));
	const host = {
		exec: vi.fn(async (command: string, _timeoutMs: number) => ({
			exitCode: 0,
			stdout: command.includes("mktemp")
				? "/tmp/ytimesy-git-proxy-abcdefgh\n"
				: "",
			stderr: "",
		})),
		writeTextFile: vi.fn(async () => undefined),
	};
	await receiveProxiedRepository(host, {
		userId: "00000000-0000-4000-8000-000000000001",
		projectId: "00000000-0000-4000-8000-000000000002",
		owner: "fixture",
		name: "repository",
		branch: "main",
		installationId: 1,
		mode: "clone",
		destination: "/workspace/repository",
	});
	expect(
		host.exec.mock.calls.find(([command]) => command.includes("mktemp"))?.[1],
	).toBe(15_000);
	expect(
		host.exec.mock.calls.find(([command]) =>
			command.includes("fetch --no-tags"),
		)?.[1],
	).toBe(120_000);
	expect(host.exec.mock.calls.at(-1)?.[1]).toBe(10_000);
});
