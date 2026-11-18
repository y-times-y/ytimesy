/**
 * Keys of a stored user message that no reader of a subagent tree, a spend
 * read or a peer-message check uses: the files sent with it, the memory
 * recalled for it and the context measurement. Dropped in the database so
 * they never leave it (`agentSessionItemsOfKindsForOwner`).
 */
export const USER_MESSAGE_BULK_KEYS = [
	"attachments",
	"memory",
	"contextUsage",
] as const;
