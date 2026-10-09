import { z } from "zod";
import { environmentModel } from "./environment-model";

/** Reference-only admission. Credentials and project-secret values never enter Workflow parameters. */
export const environmentWorkflowRequest = z
	.object({
		requestId: z.uuid(),
		workspaceId: z.uuid(),
		force: z.boolean(),
		repairModel: environmentModel.nullable(),
	})
	.strict();
export type EnvironmentWorkflowRequest = z.infer<
	typeof environmentWorkflowRequest
>;
