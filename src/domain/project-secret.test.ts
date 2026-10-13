import { describe, expect, it } from "vitest";
import {
	agentSecretsEnvFile,
	agentSecretsEnvPath,
	parseProjectSecretName,
	parseProjectSecretValue,
} from "./project-secret";

describe("project secrets", () => {
	it("writes an env file the guest can source without leaking values into names", () => {
		expect(
			agentSecretsEnvFile([
				{ name: "OPENAI_API_KEY", value: "sk-secret'value" },
			]),
		).toBe("export OPENAI_API_KEY='sk-secret'\\''value'\n");
		expect(agentSecretsEnvFile([])).toBe("# No project secrets configured.\n");
		expect(agentSecretsEnvPath("/home/ubuntu/")).toBe(
			"/home/ubuntu/.ytimesy-agent-secrets.env",
		);
	});

	it("rejects reserved or malformed names", () => {
		expect(parseProjectSecretName("GH_TOKEN")).toBe("GH_TOKEN");
		expect(() => parseProjectSecretName("path")).toThrow(/uppercase/);
		expect(() => parseProjectSecretName("PATH")).toThrow(/reserved/);
		expect(() => parseProjectSecretValue("   ")).toThrow(/required/);
	});
});
