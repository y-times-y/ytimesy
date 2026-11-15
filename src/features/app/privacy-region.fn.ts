import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import {
	analyticsOptInRequest,
	strictPrivacyRequest,
} from "#/domain/privacy-region";

export type PrivacyRegion = {
	/** EU, EEA, UK or Switzerland: no session replay, training starts off. */
	readonly strict: boolean;
	/** Analytics waits for consent: no session replay, nothing kept in the browser. */
	readonly analyticsOptIn: boolean;
};

/** Read once by the root route while the page renders on the server. */
export const readPrivacyRegionFn = createServerFn({ method: "GET" }).handler(
	async (): Promise<PrivacyRegion> => {
		const request = getRequest() as Request & { cf?: unknown };
		return {
			strict: strictPrivacyRequest(request),
			analyticsOptIn: analyticsOptInRequest(request),
		};
	},
);
