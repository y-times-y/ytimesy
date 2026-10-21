import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { PLUGIN_CATALOG } from "#/domain/plugin-catalog";
import {
	listInstalls,
	removeInstall,
	setInstallEnabled,
} from "#/server/adapters/plugin-installs";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import { installCatalogPlugin } from "#/server/services/plugin-install";

export const getPluginsFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const user = await requireUser(getRequest().headers);
		return {
			catalog: PLUGIN_CATALOG.map(
				({ id, displayName, description, settings }) => ({
					id,
					displayName,
					description,
					settings: settings ?? [],
				}),
			),
			installed: await listInstalls(user.id),
			requestUrl: process.env.YTIMESY_PLUGIN_REQUEST_URL ?? null,
		};
	},
);

export const installPluginFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({
				catalogId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
				projectId: z.string().uuid().nullable().default(null),
				config: z
					.record(z.string().max(128), z.string().max(4096))
					.refine((config) => Object.keys(config).length <= 64, {
						message: "Too many settings.",
					})
					.default({}),
			})
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		const installed = await installCatalogPlugin({ userId: user.id, ...data });
		return { installed, plugins: await listInstalls(user.id) };
	});

export const setPluginEnabledFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ id: z.string().uuid(), enabled: z.boolean() })
			.strict()
			.parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await setInstallEnabled(user.id, data.id, data.enabled);
		return listInstalls(user.id);
	});

export const uninstallPluginFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z.object({ id: z.string().uuid() }).strict().parse(data),
	)
	.handler(async ({ data }) => {
		const request = getRequest();
		requireSameOrigin(request);
		const user = await requireUser(request.headers);
		await removeInstall(user.id, data.id);
		return listInstalls(user.id);
	});
