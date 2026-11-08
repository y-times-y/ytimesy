import { describe, expect, it } from "vitest";
import {
	findPastedSecrets,
	messageWithSecretsAsVariables,
} from "./pasted-secrets";

const github = `ghp_${"a1B2".repeat(9)}`;
const anthropic = `sk-ant-${"x".repeat(30)}`;

describe("findPastedSecrets", () => {
	it("names known token formats", () => {
		expect(findPastedSecrets(`use ${github} and ${anthropic}`)).toEqual([
			{ name: "ANTHROPIC_API_KEY", value: anthropic },
			{ name: "GITHUB_TOKEN", value: github },
		]);
	});
	it("reads NAME=value assignments with the pasted name", () => {
		expect(findPastedSecrets('STRIPE_WEBHOOK_SECRET="whsec_12345678"')).toEqual(
			[{ name: "STRIPE_WEBHOOK_SECRET", value: "whsec_12345678" }],
		);
	});
	it("numbers a second distinct value and ignores repeats", () => {
		const other = `ghp_${"z9Y8".repeat(9)}`;
		expect(
			findPastedSecrets(`${github} ${github} ${other}`).map((s) => s.name),
		).toEqual(["GITHUB_TOKEN", "GITHUB_TOKEN_2"]);
	});
	it("leaves ordinary text alone", () => {
		expect(findPastedSecrets("fix the sk-learn import, PATH=/usr/bin")).toEqual(
			[],
		);
	});
});

describe("messageWithSecretsAsVariables", () => {
	it("replaces values and tells the model the variable names", () => {
		const result = messageWithSecretsAsVariables(`token ${github}`, [
			{ name: "GITHUB_TOKEN", value: github },
		]);
		expect(result).not.toContain(github);
		expect(result).toContain("token $GITHUB_TOKEN");
	});
});
