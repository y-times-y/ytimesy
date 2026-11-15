/** SQL that finds the rows a machine slug names by primary key, not by scanning. */

/**
 * SQL matching the agent_session rows whose VM slug is `slug` (an SQL text
 * expression): the slug holds the id's first 16 hex digits (then, for a
 * replacement machine, '-r<generation>'), so they bound a primary-key range
 * scan, and the equality on the 27-character base still decides. The ranges
 * are null (no row) for anything that is not such a slug.
 */
export function sessionSlugMatch(slug: string, column = "id") {
	const prefix = `substr(${slug},12,8)||'-'||substr(${slug},20,4)||'-'||substr(${slug},24,4)`;
	const valid = `${slug} ~ '^ytimesy-ag-[0-9a-f]{16}(-r[0-9]+)?$'`;
	return `${column} between (case when ${valid} then (${prefix}||'-0000-000000000000')::uuid end)
	 and (case when ${valid} then (${prefix}||'-ffff-ffffffffffff')::uuid end)
	 and 'ytimesy-ag-' || left(replace(${column}::text,'-',''),16)=left(${slug},27)`;
}

/**
 * SQL true when the slug text expression `slug` names a machine of the chat
 * whose id is the expression `id`, whatever its generation (the original
 * 'ytimesy-ag-<id16>' or '...-r<n>').
 */
export function sessionSlugFamily(slug: string, id: string) {
	return `(left(${slug},27)='ytimesy-ag-'||left(replace(${id}::text,'-',''),16) and (length(${slug})=27 or ${slug} ~ '^.{27}-r[0-9]+$'))`;
}

/** An id lookup for a slug '<prefix><uuid>', null unless it is one; the slug equality still decides. */
export function uuidSlugMatch(slug: string, prefix: string, column: string) {
	const valid = `${slug} ~ '^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;
	return `${column} = (case when ${valid} then substr(${slug},${prefix.length + 1})::uuid end)
	 and '${prefix}' || ${column}::text=${slug}`;
}
