import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { vmNetworkPolicy } from "#/domain/vm-network-policy";
import {
	projectNetworkPolicy,
	saveProjectNetworkPolicy,
} from "#/server/adapters/project-network-policy";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

const projectInput = z.object({ projectId: z.uuid() });
export const readNetworkAccessFn = createServerFn({ method: "GET" })
	.validator((data: unknown) => projectInput.parse(data))
	.handler(async ({ data }) =>
		projectNetworkPolicy(
			(await requireUser(getRequest().headers)).id,
			data.projectId,
		),
	);

export const saveNetworkAccessFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		projectInput.extend({ policy: vmNetworkPolicy }).parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		return saveProjectNetworkPolicy(user.id, data.projectId, data.policy);
	});
