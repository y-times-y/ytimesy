/**
 * The first few caller functions in an error stack, so a log line can say who
 * asked for something expensive. Function names only, never paths or values.
 * `skip` drops frames whose text contains any of its strings (the helper's own).
 */
export function callerHintFromStack(
	stack: string | undefined,
	skip: readonly string[] = [],
	limit = 3,
) {
	return (stack ?? "")
		.split("\n")
		.slice(1)
		.map((line) => line.trim().replace(/^at\s+/, ""))
		.map((rest) => {
			// "async name (location)" or just a location for an anonymous frame.
			const parts = /^(?:async\s+)?(.*?)\s*\((.*)\)$/.exec(rest);
			return parts
				? { name: parts[1] ?? "", where: parts[2] ?? "" }
				: { name: "", where: rest };
		})
		.filter(
			({ name, where }) =>
				name &&
				name !== "callerHintFromStack" &&
				!where.includes("node:") &&
				!skip.some((text) => name.includes(text) || where.includes(text)),
		)
		.slice(0, limit)
		.map(({ name }) => name)
		.join(" < ");
}
