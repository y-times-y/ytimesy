import { useEffect, useState } from "react";

export function StartingTurn() {
	const [waiting, setWaiting] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setWaiting(true), 20_000);
		return () => clearTimeout(timer);
	}, []);
	return (
		<p
			className={
				waiting ? "session-working" : "session-working session-shimmer"
			}
			role="status"
		>
			{waiting ? "Still waiting for the first response or step…" : "Starting…"}
		</p>
	);
}
