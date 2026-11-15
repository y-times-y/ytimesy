import { useEffect, useState } from "react";
import {
	REPLAY_CHOICE_EVENT,
	type ReplayBrowserBlock,
	type ReplayChoice,
	readReplayChoice,
	replayBrowserBlock,
} from "./replay-choice";

/**
 * The browser-held choice and privacy signal, read after hydration (the
 * server can't know them); null until then, and live when it changes.
 */
export function useReplayChoice() {
	const [state, setState] = useState<{
		readonly choice: ReplayChoice | null;
		readonly block: ReplayBrowserBlock | null;
	} | null>(null);
	useEffect(() => {
		const read = () =>
			setState({ choice: readReplayChoice(), block: replayBrowserBlock() });
		read();
		window.addEventListener(REPLAY_CHOICE_EVENT, read);
		window.addEventListener("storage", read);
		return () => {
			window.removeEventListener(REPLAY_CHOICE_EVENT, read);
			window.removeEventListener("storage", read);
		};
	}, []);
	return state;
}
