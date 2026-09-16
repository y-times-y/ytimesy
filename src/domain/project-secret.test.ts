import { describe, expect, it } from "vitest";
import {
	agentSecretsDeveloperNote,
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
		expect(agentSecretsEnvPath("/home/ubuntu/")).toBe(
			"/home/ubuntu/.ytimesy-agent-secrets.env",
		);
	});

	it("lists secret names for the agent and never includes values", () => {
		const note = agentSecretsDeveloperNote(["GH_TOKEN", "OPENAI_API_KEY"]);
		expect(note).toContain("GH_TOKEN");
		expect(note).toContain("OPENAI_API_KEY");
		expect(note).toMatch(/Never print/);
		expect(note).not.toContain("sk-");
	});

	it("rejects reserved or malformed names", () => {
		expect(parseProjectSecretName("GH_TOKEN")).toBe("GH_TOKEN");
		expect(() => parseProjectSecretName("path")).toThrow(/uppercase/);
		expect(() => parseProjectSecretName("PATH")).toThrow(/reserved/);
		expect(() => parseProjectSecretValue("   ")).toThrow(/required/);
	});
});
