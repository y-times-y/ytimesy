import { describe, expect, it } from "vitest";
import {
	JOB_WORKER_GUEST_CERT,
	JOB_WORKER_GUEST_GITHUB_KEY,
	JOB_WORKER_IDLE_TIMEOUT_SECONDS,
	JOB_WORKER_METADATA_PURPOSE,
	JOB_WORKER_SLUG,
	jobWorkerCreateVmFields,
	jobWorkerDatabaseUrl,
	jobWorkerEnvFile,
	jobWorkerIdleNeedsUpdate,
} from "./job-worker-vm";
import { CHEAP_BASE_SNAPSHOT } from "./product-vm";
import { GUEST_INTERNET_FIREWALL } from "./proof-vm";

describe("jobWorkerCreateVmFields", () => {
	it("never idles and never expires a run", () => {
		expect(jobWorkerCreateVmFields()).toEqual({
			slug: JOB_WORKER_SLUG,
			displayName: "ytimesy job worker",
			firewall: GUEST_INTERNET_FIREWALL,
			metadata: { purpose: JOB_WORKER_METADATA_PURPOSE },
			snapshotId: CHEAP_BASE_SNAPSHOT,
			idleTimeoutSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
			maxRunSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
			maxRunTotalSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
			autoDeleteSeconds: JOB_WORKER_IDLE_TIMEOUT_SECONDS,
			automaticRestart: true,
		});
	});

	it("treats any pause window as stale", () => {
		expect(jobWorkerIdleNeedsUpdate(180)).toBe(true);
		expect(jobWorkerIdleNeedsUpdate(-1)).toBe(false);
	});
});

describe("jobWorkerEnvFile", () => {
	it("points TLS and the GitHub key at guest paths", () => {
		const env = jobWorkerEnvFile(
			[
				"DATABASE_URL=postgresql://db.example:5432/postgres?sslmode=verify-full&sslrootcert=.secrets/supabase-ca.crt",
				'GITHUB_PRIVATE_KEY_PATH="/tmp/local.pem"',
				"FREESTYLE_API_KEY=fs_test",
			].join("\n"),
			{
				cert: JOB_WORKER_GUEST_CERT,
				githubKey: JOB_WORKER_GUEST_GITHUB_KEY,
			},
		);
		expect(env).toContain(
			`sslrootcert=${encodeURIComponent(JOB_WORKER_GUEST_CERT)}`,
		);
		expect(env).toMatch(/^DATABASE_URL="/m);
		expect(env).toContain(
			`GITHUB_PRIVATE_KEY_PATH="${JOB_WORKER_GUEST_GITHUB_KEY}"`,
		);
		expect(env).toContain("FREESTYLE_API_KEY=fs_test");
		expect(
			jobWorkerDatabaseUrl("postgresql://db.example/postgres", "/c.crt"),
		).toBe("postgresql://db.example/postgres?sslrootcert=%2Fc.crt");
	});
});
