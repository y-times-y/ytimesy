import { createDevMachineEngine } from "@rigkit/engine";
import {
	claimEnvironmentBuild,
	failEnvironmentPreflight,
	finishEnvironmentBuild,
	resolveEnvironmentBuildInput,
} from "../../services/environment-build.ts";
import { closeDatabase } from "../database.ts";

const [, , root, workspaceId, mode] = process.argv;
let input;
let buildId;
let cleanup;
function finish() {
	cleanup ??= (async () => {
		try {
			if (input && buildId) await finishEnvironmentBuild(input, buildId);
		} finally {
			await closeDatabase();
		}
	})();
	return cleanup;
}
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.once(signal, () => {
		void finish().finally(() => process.exit(1));
	});
}
try {
	input = await resolveEnvironmentBuildInput(
		workspaceId,
		mode === "force",
		undefined,
		JSON.parse(process.env.YTIMESY_ENVIRONMENT_REPAIR_MODEL || "null"),
	);
	if (input) {
		buildId = await claimEnvironmentBuild(input);
		process.env.YTIMESY_ENVIRONMENT_BUILD_ID = buildId;
		process.env.YTIMESY_ENVIRONMENT_INPUT = JSON.stringify(input);
		const engine = await createDevMachineEngine({ projectDir: root });
		const loaded = await engine.load();
		if (loaded.workflows.length !== 1)
			throw new Error("Expected one environment workflow.");
		await engine.apply({ workflow: loaded.workflows[0].name });
	}
} catch {
	process.exitCode = 1;
	if (!buildId) await failEnvironmentPreflight(workspaceId);
} finally {
	try {
		await finish();
	} catch {
		process.exitCode = 1;
	}
}
