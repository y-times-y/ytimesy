import { describe, expect, it } from "vitest";
import {
	parseProductionEnvSecret,
	productionEnvFileText,
	withCertificatePath,
} from "../scripts/production-env-secret";

// The shapes below are the ones the stored secret really has, with fake values.
const FLATTENED =
	"# Production values. Never commit. " +
	'DATABASE_URL="postgresql://postgres.ref:pw@host:5432/postgres?sslmode=verify-full&sslrootcert=/Users/someone/cloud/.secrets/supabase-ca.crt" ' +
	"APP_URL=https://example.com " +
	"YTIMESY_GIT_PROXY_URL=https://edge.example.com # the executor's custom domain " +
	'FREESTYLE_API_KEY="fs_key_123" # (rotate quarterly) ' +
	'GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END RSA PRIVATE KEY-----\\n" ' +
	"R2_CHECKPOINT_BUCKET=bucket-name # per environment " +
	"YTIMESY_FLEET_MONTHLY_MICRO_USD=500000000";

describe("production env secret", () => {
	it("splits a flattened file into its variables and drops the comments", () => {
		const entries = parseProductionEnvSecret(FLATTENED);
		expect([...entries.keys()]).toEqual([
			"DATABASE_URL",
			"APP_URL",
			"YTIMESY_GIT_PROXY_URL",
			"FREESTYLE_API_KEY",
			"GITHUB_PRIVATE_KEY",
			"R2_CHECKPOINT_BUCKET",
			"YTIMESY_FLEET_MONTHLY_MICRO_USD",
		]);
		expect(entries.get("APP_URL")).toBe("https://example.com");
		// A trailing comment is not part of an unquoted value.
		expect(entries.get("YTIMESY_GIT_PROXY_URL")).toBe(
			"https://edge.example.com",
		);
		expect(entries.get("R2_CHECKPOINT_BUCKET")).toBe("bucket-name");
		// Nor of a quoted one, which keeps its quotes for the env-file reader.
		expect(entries.get("FREESTYLE_API_KEY")).toBe('"fs_key_123"');
	});

	it("keeps a multi-line key whole, escapes and all", () => {
		const key = parseProductionEnvSecret(FLATTENED).get("GITHUB_PRIVATE_KEY");
		expect(key).toBe(
			'"-----BEGIN RSA PRIVATE KEY-----\\nAAAA\\nBBBB\\n-----END RSA PRIVATE KEY-----\\n"',
		);
	});

	it("also reads the original file, with real line breaks", () => {
		const entries = parseProductionEnvSecret(
			'APP_URL=https://example.com\n# a note\nR2_ACCOUNT_ID="abc"\n',
		);
		expect([...entries]).toEqual([
			["APP_URL", "https://example.com"],
			["R2_ACCOUNT_ID", '"abc"'],
		]);
	});

	it("points the database URL at this machine's certificate, and nothing else", () => {
		const text = productionEnvFileText(
			parseProductionEnvSecret(FLATTENED),
			"/tmp/work/ca.crt",
		);
		const lines = text.trim().split("\n");
		expect(lines).toHaveLength(7);
		const database = lines.find((line) => line.startsWith("DATABASE_URL="));
		expect(database).toContain("sslrootcert=/tmp/work/ca.crt");
		expect(database).not.toContain("/Users/someone");
		expect(database).toContain("sslmode=verify-full");
		expect(lines).toContain("APP_URL=https://example.com");
		expect(text.endsWith("\n")).toBe(true);
	});

	it("rewrites only the certificate path of a URL", () => {
		expect(
			withCertificatePath(
				"postgres://u@h/db?sslrootcert=/old&sslmode=verify-full",
				"/new",
			),
		).toBe("postgres://u@h/db?sslrootcert=/new&sslmode=verify-full");
		expect(withCertificatePath("postgres://u@h/db", "/new")).toBe(
			"postgres://u@h/db",
		);
	});
});
