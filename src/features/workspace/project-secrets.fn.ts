import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { PublicProjectSecret } from "#/domain/project-secret";
import { requireUser } from "#/server/auth/auth";
import {
	listVisibleProjectSecrets,
	removeVisibleProjectSecret,
	saveVisibleProjectSecret,
} from "#/server/services/project-secrets";

function projectIdFrom(data: { projectId?: string } | undefined) {
	const projectId =
		typeof data?.projectId === "string" ? data.projectId.trim() : "";
	if (!projectId) throw new Error("Select a project first.");
	return projectId;
}

export const listProjectSecretsFn = createServerFn({ method: "GET" })
	.validator((data: { projectId?: string } | undefined) => ({
		projectId: projectIdFrom(data),
	}))
	.handler(async ({ data }): Promise<readonly PublicProjectSecret[]> => {
		const user = await requireUser(getRequest().headers);
		return listVisibleProjectSecrets(user.id, data.projectId);
	});

export const saveProjectSecretFn = createServerFn({ method: "POST" })
	.validator((data: { projectId?: string; name?: string; value?: string }) => ({
		projectId: projectIdFrom(data),
		name: typeof data.name === "string" ? data.name : "",
		value: typeof data.value === "string" ? data.value : "",
	}))
	.handler(async ({ data }): Promise<readonly PublicProjectSecret[]> => {
		const user = await requireUser(getRequest().headers);
		await saveVisibleProjectSecret({
			userId: user.id,
			projectId: data.projectId,
			name: data.name,
			value: data.value,
		});
		return listVisibleProjectSecrets(user.id, data.projectId);
	});

export const deleteProjectSecretFn = createServerFn({ method: "POST" })
	.validator((data: { projectId?: string; secretId?: string }) => ({
		projectId: projectIdFrom(data),
		secretId: typeof data.secretId === "string" ? data.secretId.trim() : "",
	}))
	.handler(async ({ data }): Promise<readonly PublicProjectSecret[]> => {
		const user = await requireUser(getRequest().headers);
		if (!data.secretId) throw new Error("Secret is not available.");
		await removeVisibleProjectSecret({
			userId: user.id,
			projectId: data.projectId,
			secretId: data.secretId,
		});
		return listVisibleProjectSecrets(user.id, data.projectId);
	});
