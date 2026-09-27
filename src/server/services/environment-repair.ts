import type { EnvironmentRepairPlan } from "#/domain/environment-repair";
import { posixShellQuoted as quote } from "#/domain/posix-command";
import { guestNodePath } from "../adapters/repository-setup";
import type {
	RuntimeCommandResult,
	WorkspaceRuntime,
} from "../adapters/workspace-runtime";

export type DiagnoseEnvironmentFailure = (
	failure: RuntimeCommandResult,
) => Promise<EnvironmentRepairPlan>;

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
	for (let attempt = 0; attempt <= 2; attempt++) {
		const result = await input.runtime.exec(
			input.vm,
			["bash", "-lc", input.command],
			input.env,
			input.timeoutMs,
		);
		if (result.exitCode === 0) return;
		if (attempt === 2) break;
		await input.onRepair(attempt + 1);
		const plan = await input.diagnose(result);
		if (plan.action === "blocked") break;
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
	throw new Error(
		"Environment setup could not be repaired within two attempts. Check missing credentials, required tooling, or the install command; then retry.",
	);
}
