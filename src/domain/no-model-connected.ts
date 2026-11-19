/** The message a chat start returns when no model route is connected. */
export const NO_MODEL_CONNECTED_MESSAGE = "Choose a model to start this chat.";

export function isNoModelConnected(message: string | null | undefined) {
	return message === NO_MODEL_CONNECTED_MESSAGE;
}
