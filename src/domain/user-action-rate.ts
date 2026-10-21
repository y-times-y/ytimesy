export type UserAction = "chat-send" | "project-create" | "vm-create";

/**
 * Per-user abuse limits, fixed windows. Generous for real use: a person
 * cannot type 20 messages a minute, and builder subagents start their own
 * machines, so VM creation allows a burst well beyond a busy session.
 */
export const USER_ACTION_LIMITS: Readonly<
	Record<UserAction, { limit: number; windowSeconds: number; message: string }>
> = {
	"chat-send": {
		limit: 20,
		windowSeconds: 60,
		message:
			"You are sending messages too quickly. Wait a minute, then send again.",
	},
	"project-create": {
		limit: 10,
		windowSeconds: 3600,
		message:
			"You have added too many projects in the last hour. Try again later.",
	},
	"vm-create": {
		limit: 60,
		windowSeconds: 3600,
		message:
			"This account started too many new machines in the last hour. Wait a few minutes, then retry; your work is preserved.",
	},
};

export class UserActionRateLimited extends Error {
	constructor(readonly action: UserAction) {
		super(USER_ACTION_LIMITS[action].message);
		this.name = "UserActionRateLimited";
	}
}
