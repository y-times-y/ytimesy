import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import type { LocalImportView } from "#/domain/local-import-view";
import { UserActionRateLimited } from "#/domain/user-action-rate";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";
import {
	createLocalImport,
	localImportStatus,
} from "#/server/services/local-import";

/** Copy prompt: a new import code inside the prompt for the local agent. */
export const createLocalImportFn = createServerFn({ method: "POST" })
	// An empty object, so the call has the JSON body requireSameOrigin needs.
	.validator((data: unknown) => z.object({}).strict().parse(data))
	.handler(async () => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		try {
			return await createLocalImport(user.id);
		} catch (error) {
			if (error instanceof UserActionRateLimited)
				throw new Error(error.message);
			throw error;
		}
	});

/** The card's status line polls this while the import runs. */
export const localImportStatusFn = createServerFn({ method: "GET" })
	.validator((data: unknown) =>
		z.object({ importId: z.uuid() }).strict().parse(data),
	)
	.handler(async ({ data }): Promise<LocalImportView> => {
		const user = await requireUser(getRequest().headers);
		return localImportStatus(user.id, data.importId);
	});
