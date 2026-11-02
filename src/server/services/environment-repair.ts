import type { EnvironmentRepairPlan } from "#/domain/environment-repair";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { guestNodePath } from "../adapters/repository-setup";
import type {
	RuntimeCommandResult,
	WorkspaceRuntime,
} from "../adapters/workspace-runtime";

type DiagnoseEnvironmentFailure = (
	failure: RuntimeCommandResult,
) => Promise<EnvironmentRepairPlan>;

/** The install still failed after repairs; carries its last result. */
export class EnvironmentInstallFailed extends Error {
	readonly result: RuntimeCommandResult;
	constructor(result: RuntimeCommandResult) {
		super(
			"Environment setup could not be repaired within two attempts. Check missing credentials, required tooling, or the install command; then retry.",
		);
		this.name = "EnvironmentInstallFailed";
		this.result = result;
	}
}

/** Two repairs at most; the original install remains the authority on success. */
export async function installWithEnvironmentRepair(input: {
	runtime: WorkspaceRuntime;
	vm: string;
	command: string;
	env: Record<string, string>;
	timeoutMs: number;
	diagnose: DiagnoseEnvironmentFailure;
	onRepair: (attempt: number) => Promise<void>;
}) {
	let last: RuntimeCommandResult | null = null;
	for (let attempt = 0; attempt <= 2; attempt++) {
		const result = await input.runtime.exec(
			input.vm,
			["bash", "-lc", input.command],
			input.env,
			input.timeoutMs,
		);
		if (result.exitCode === 0) return;
		last = result;
		if (attempt === 2) break;
		await input.onRepair(attempt + 1);
		// Without an authorized model (or a usable diagnosis) the install's own
		// failure is what the person sees.
		const plan = await input.diagnose(result).catch(() => null);
		if (!plan || plan.action === "blocked") break;
		const command =
			plan.action === "enable-corepack"
				? guestNodePath()
				: plan.action === "install-packages"
					? `sudo -n apt-get update && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${plan.packages.map(quote).join(" ")}`
					: null;
		if (command) {
			const repaired = await input.runtime.exec(
				input.vm,
				["bash", "-lc", command],
				{},
				180_000,
			);
			if (repaired.exitCode !== 0) break;
		}
	}
	throw new EnvironmentInstallFailed(
		last ?? { exitCode: 1, stdout: "", stderr: "" },
	);
}
