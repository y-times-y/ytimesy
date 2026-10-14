import { officialOpenRouterProviders } from "#/domain/api-model-list";

/**
 * Pins every OpenRouter request to the model maker's own providers with
 * fallbacks off: if the maker's endpoint is unavailable the request fails
 * instead of moving to a third-party host.
 */
export function openRouterOfficialFetch(
	fetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
	return async (url, init) => {
		if (typeof init?.body !== "string") return fetch(url, init);
		const body = JSON.parse(init.body) as Record<string, unknown>;
		if (typeof body.model !== "string") return fetch(url, init);
		const only = officialOpenRouterProviders(body.model);
		if (!only)
			throw new Error(
				`${body.model} is not an offered model; OpenRouter requests are limited to listed models.`,
			);
		const provider =
			body.provider && typeof body.provider === "object" ? body.provider : {};
		return fetch(url, {
			...init,
			body: JSON.stringify({
				...body,
				provider: { ...provider, only, allow_fallbacks: false },
			}),
		});
	};
}
