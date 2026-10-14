import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	AGENT_SECRETS_ENV_PATH,
	agentSecretsEnvFile,
	parseProjectSecretKind,
	parseProjectSecretName,
	parseProjectSecretValue,
	REDACTED,
	redactSecretValues,
	SECRET_COMMIT_GUARD,
} from "./project-secret";

describe("project secrets", () => {
	it("exports environment variables and runtime secrets, never build secrets", () => {
		expect(
			agentSecretsEnvFile([
				{ name: "OPENAI_API_KEY", value: "sk-secret'value", kind: "runtime" },
				{ name: "APP_MODE", value: "staging", kind: "environment" },
				{ name: "NPM_TOKEN", value: "npm-build-only", kind: "build" },
			]),
		).toBe(
			"export OPENAI_API_KEY='sk-secret'\\''value'\nexport APP_MODE='staging'\nYTIMESY_REDACTED_SECRETS='OPENAI_API_KEY'\n",
		);
		expect(agentSecretsEnvFile([])).toBe("# No project secrets configured.\n");
	});

	it("rejects reserved or malformed names, kinds and short runtime values", () => {
		expect(parseProjectSecretName("GH_TOKEN")).toBe("GH_TOKEN");
		expect(() => parseProjectSecretName("path")).toThrow(/uppercase/);
		expect(() => parseProjectSecretName("PATH")).toThrow(/reserved/);
		expect(() => parseProjectSecretName("YTIMESY_REDACTED_SECRETS")).toThrow(
			/reserved/,
		);
		expect(() => parseProjectSecretValue("   ")).toThrow(/required/);
		expect(() => parseProjectSecretValue("abc", "runtime")).toThrow(/at least/);
		expect(parseProjectSecretValue("abc", "environment")).toBe("abc");
		expect(() => parseProjectSecretKind("secret")).toThrow(/type/);
	});

	it("redacts runtime values anywhere in tool output", () => {
		expect(
			redactSecretValues(
				{ stdout: "key=sk-live-123456 ok", lines: ["sk-live-123456"], code: 0 },
				["sk-live-123456"],
			),
		).toEqual({
			stdout: `key=${REDACTED} ok`,
			lines: [REDACTED],
			code: 0,
		});
	});

	it("refuses commits whose changes or unpushed history contain a runtime value", () => {
		const repo = mkdtempSync(join(tmpdir(), "secret-guard-"));
		const env = join(repo, "..", `${repo.split("/").pop()}.env`);
		writeFileSync(
			env,
			agentSecretsEnvFile([
				{ name: "STRIPE_KEY", value: "sk_test_abcdef123", kind: "runtime" },
			]),
		);
		const guard = SECRET_COMMIT_GUARD.replaceAll(AGENT_SECRETS_ENV_PATH, env);
		const sh = (script: string) =>
			execFileSync("bash", ["-c", script], { cwd: repo, encoding: "utf8" });
		sh(
			"git init -q && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init",
		);
		writeFileSync(join(repo, "safe.txt"), "uses process.env.STRIPE_KEY\n");
		expect(() => sh(`git add -A && ${guard}`)).not.toThrow();
		writeFileSync(join(repo, "leak.txt"), "key = sk_test_abcdef123\n");
		expect(() => sh(`git add -A && ${guard}`)).toThrow(/STRIPE_KEY/);
		expect(sh("git diff --cached --name-only")).toBe("");
	});
});
