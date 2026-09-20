import { GUEST_INTERNET_FIREWALL } from "./proof-vm";
import { CHEAP_BASE_SNAPSHOT } from "./product-vm";

export const JOB_WORKER_SLUG = "ytimesy-job-worker";
export const JOB_WORKER_METADATA_PURPOSE = "ytimesy-job-worker";
export const JOB_WORKER_IDLE_TIMEOUT_SECONDS = -1;
export const JOB_WORKER_GUEST_ROOT = "/home/ubuntu/ytimesy-worker";
export const JOB_WORKER_GUEST_CERT = `${JOB_WORKER_GUEST_ROOT}/.secrets/supabase-ca.crt`;
export const JOB_WORKER_GUEST_GITHUB_KEY = `${JOB_WORKER_GUEST_ROOT}/.secrets/github.pem`;

/** Always-on poller. Idle pause would stop the queue. */
export function jobWorkerCreateVmFields() {
	return {
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
	};
}

export function jobWorkerIdleNeedsUpdate(
	current: number | null | undefined,
) {
	return current !== JOB_WORKER_IDLE_TIMEOUT_SECONDS;
}

export function jobWorkerDatabaseUrl(databaseUrl: string, certPath: string) {
	const url = new URL(databaseUrl);
	url.searchParams.set("sslrootcert", certPath);
	return url.toString();
}

export function jobWorkerEnvFile(
	source: string,
	paths: { readonly cert: string; readonly githubKey: string },
) {
	return source
		.split("\n")
		.map((line) => {
			const match = /^(DATABASE_URL|GITHUB_PRIVATE_KEY_PATH)=(.*)$/.exec(
				line,
			);
			if (!match) return line;
			const [, key, raw] = match;
			const value = unquoteEnvValue(raw);
			if (key === "DATABASE_URL")
				return `DATABASE_URL="${jobWorkerDatabaseUrl(value, paths.cert)}"`;
			return `GITHUB_PRIVATE_KEY_PATH="${paths.githubKey}"`;
		})
		.join("\n");
}

function unquoteEnvValue(value: string) {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}
