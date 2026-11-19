import { isNoModelConnected } from "#/domain/no-model-connected";
import { SendBlockStep } from "../sessions/send-block-step";

/**
 * Why a chat started from an issue or pull request did not open. With no
 * model connected, the in-place "choose a model" step shows (as under the
 * composer) instead of a bare error line.
 */
export function StartChatError({ message }: { message: string }) {
	if (isNoModelConnected(message))
		return (
			<SendBlockStep
				block={{
					kind: "no_model",
					message: "Add a model to start this chat.",
					actionLabel: "Open Settings",
					action: "agents",
				}}
			/>
		);
	return (
		<span className="gh-error" role="alert">
			{message}
		</span>
	);
}
