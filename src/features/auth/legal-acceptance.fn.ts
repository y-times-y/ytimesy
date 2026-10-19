import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import {
	CURRENT_LEGAL_VERSIONS,
	legalAcceptanceCurrent,
} from "#/domain/legal-acceptance";
import {
	legalAcceptanceFor,
	recordLegalAcceptance,
} from "#/server/adapters/legal-acceptance";
import { requireUser } from "#/server/auth/auth";
import { requireSameOrigin } from "#/server/http";

export type LegalAcceptanceStatus = {
	/** False when the user never accepted, or accepted an older version. */
	current: boolean;
	/** True when an older version was accepted (the copy says "updated"). */
	updated: boolean;
};

export const getLegalAcceptanceFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<LegalAcceptanceStatus> => {
		const user = await requireUser(getRequest().headers);
		const accepted = await legalAcceptanceFor(user.id);
		return {
			current: legalAcceptanceCurrent(accepted),
			updated: accepted !== null,
		};
	},
);

/**
 * Accepts the versions the client was shown. A stale tab that shows older
 * versions cannot record acceptance of newer ones.
 */
export const acceptLegalTermsFn = createServerFn({ method: "POST" })
	.validator((data: unknown) =>
		z
			.object({ termsVersion: z.string(), privacyVersion: z.string() })
			.parse(data),
	)
	.handler(async ({ data }) => {
		requireSameOrigin(getRequest());
		const user = await requireUser(getRequest().headers);
		if (!legalAcceptanceCurrent(data))
			throw new Response("The Terms changed; reload to read them.", {
				status: 409,
			});
		await recordLegalAcceptance(user.id, "prompt");
		return { versions: CURRENT_LEGAL_VERSIONS };
	});
