import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { machineSizeId } from "#/domain/machine-size";
import {
	projectMachineSize,
	saveProjectMachineSize,
} from "#/server/adapters/project-machine-size";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

const projectInput = z.object({ projectId: z.uuid() });
export const readMachineSizeFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) =>
		projectMachineSize(
			(await requireUser(getRequest().headers)).id,
			data.projectId,
		),
	);

export const saveMachineSizeFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ size: machineSizeId }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return saveProjectMachineSize(user.id, data.projectId, data.size);
	});
