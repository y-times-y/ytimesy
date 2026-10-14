import {
	type ApiModelSpeedId,
	openRouterRouting,
} from "#/domain/api-model-list";

/**
 * Pins every OpenRouter request to the model maker's own providers (or, for a
 * listed open-weight model, its approved hosts) with fallbacks off: if those
 * are unavailable the request fails instead of moving to another host. A
 * faster `speed` pins the maker's own tiered endpoints instead, and is refused
 * when the model has none.
 */
export function openRouterOfficialFetch(
	fetch: typeof globalThis.fetch,
	speed?: ApiModelSpeedId,
): typeof globalThis.fetch {
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body) as Record<string, unknown>;
		if (typeof body.model !== "string") return fetch(url, init);
		const routing = openRouterRouting(body.model, speed);
		if (!routing)
			throw new Error(
				speed
					? `${body.model} has no ${speed} endpoint from its maker.`
					: `${body.model} is not an offered model; OpenRouter requests are limited to listed models.`,
			);
		const provider =
			body.provider && typeof body.provider === "object" ? body.provider : {};
		return fetch(url, {
			...init,
			body: JSON.stringify({
				...body,
				provider: {
					...provider,
					only: routing.only,
					allow_fallbacks: false,
					...(routing.zdr ? { zdr: true } : {}),
				},
			}),
		});
	};
}
