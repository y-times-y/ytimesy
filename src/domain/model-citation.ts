/** Provider reference IDs are not URLs; never turn an unresolved ID into a fake link. */
export function readableModelCitations(text: string): string {
	return text
		.replace(/\uE200cite\uE202[^\uE201]*\uE201/g, "(source unavailable)")
		.replace(/\uE200(?:c(?:i(?:t(?:e)?)?)?(?:\uE202[^\uE201]*)?)?$/, "");
}
