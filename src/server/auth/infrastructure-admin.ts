/** Bootstrap authority comes from deployment configuration, never a client role or email. */
export function isInfrastructureAdmin(userId: string) {
	return (process.env.YTIMESY_ADMIN_USER_IDS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.includes(userId);
}

export function requireInfrastructureAdmin(userId: string) {
	if (!isInfrastructureAdmin(userId))
		throw new Response("Administrator access required.", { status: 403 });
}
