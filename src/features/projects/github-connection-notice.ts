import { useEffect, useState } from "react";
import {
	githubConnectionFailureMessage,
	githubConnectionFailureReason,
} from "#/domain/github-connection-callback";

/**
 * The message for a GitHub connection that just failed (`?connection=<reason>`
 * from the callback). The parameter is removed once read so a reload or a
 * later visit does not show a stale failure.
 */
export function useGithubConnectionNotice() {
	const [message, setMessage] = useState<string | null>(null);
	useEffect(() => {
		const url = new URL(window.location.href);
		const reason = githubConnectionFailureReason(
			url.searchParams.get("connection"),
		);
		if (!reason) return;
		setMessage(githubConnectionFailureMessage(reason));
		url.searchParams.delete("connection");
		window.history.replaceState(
			window.history.state,
			"",
			`${url.pathname}${url.search}${url.hash}`,
		);
	}, []);
	return [message, () => setMessage(null)] as const;
}
