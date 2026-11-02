import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { requestCountry, strictPrivacyCountry } from "#/domain/privacy-region";

export type PrivacyRegion = {
	/** EU, EEA, UK or Switzerland: no session replay, training starts off. */
	readonly strict: boolean;
};

/** Read once by the root route while the page renders on the server. */
export const readPrivacyRegionFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<PrivacyRegion> => ({
		strict: strictPrivacyCountry(
			requestCountry(getRequest() as Request & { cf?: unknown }),
		),
	}),
);
