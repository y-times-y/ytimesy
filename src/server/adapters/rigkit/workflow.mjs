import { workflow } from "@rigkit/engine";
import {
	activateEnvironmentBuild,
	prepareEnvironmentRepositories,
	provisionEnvironmentBuild,
	verifyEnvironmentRepositories,
} from "../../services/environment-build.ts";

const input = JSON.parse(process.env.YTIMESY_ENVIRONMENT_INPUT || "null");
if (!input) throw new Error("Environment input is missing.");
const buildId = process.env.YTIMESY_ENVIRONMENT_BUILD_ID;
if (!buildId) throw new Error("Environment build claim is missing.");

// Only this trusted workflow runs on the host. Repository commands run inside the VM.
export const environment = workflow("project-environment")
	.sequence("prepare")
	.configure({ ...input, buildId })
	.task("provision", async () => ({
		ctx: { vm: await provisionEnvironmentBuild(input, buildId) },
	}))
	.task("checkout-and-install", async ({ step }) => ({
		ctx: {
			...step.ctx,
			repositories: await prepareEnvironmentRepositories(input, step.ctx.vm),
		},
	}))
	.task("verify", async ({ step }) => {
		const repositories = await verifyEnvironmentRepositories(
			input,
			step.ctx.vm,
			step.ctx.repositories,
		);
		return { ctx: { ...step.ctx, repositories } };
	})
	.task("activate-snapshot", async ({ step }) => ({
		ctx: {
			snapshotId: await activateEnvironmentBuild(
				input,
				buildId,
				step.ctx.vm,
				step.ctx.repositories,
			),
		},
	}));
