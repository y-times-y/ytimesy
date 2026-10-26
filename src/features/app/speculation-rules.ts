/**
 * Lets Chrome fetch the legal pages when a pointer rests on a plain link to
 * them (the consent banner and the legal prompt link them as documents, not
 * router links). Only static, side-effect-free GET pages belong here:
 * prefetching runs the request without the visitor choosing it. In-app routes
 * already preload on intent through the router (src/router.tsx).
 */
export const SPECULATION_PAGES = ["/terms", "/privacy", "/training"] as const;

export const SPECULATION_RULES = JSON.stringify({
	prefetch: [
		{
			where: { href_matches: [...SPECULATION_PAGES] },
			eagerness: "moderate",
		},
	],
});
