/** What the user types to confirm deleting their account. */
export function accountDeletionPhrase(user: { email?: string | null }) {
	return user.email?.trim() || "delete my account";
}

export function accountDeletionConfirmed(
	user: { email?: string | null },
	typed: string,
) {
	return (
		typed.trim().toLowerCase() === accountDeletionPhrase(user).toLowerCase()
	);
}
