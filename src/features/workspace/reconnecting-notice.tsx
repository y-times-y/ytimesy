import { useEffect, useRef, useState } from "react";
import { reconnectingNotice } from "./live-freshness";
import { useHubConnection } from "./user-hub-store";

/** Bottom left: a small calm line while live updates are down, so stale data is never silent. */
export function ReconnectingNotice() {
	const connection = useHubConnection();
	const everOpen = useRef(false);
	const droppedAt = useRef<number | null>(null);
	const [now, setNow] = useState(() => Date.now());
	const [online, setOnline] = useState(true);
	if (connection.open) {
		everOpen.current = true;
		droppedAt.current = null;
	} else if (everOpen.current && droppedAt.current === null) {
		droppedAt.current = Date.now();
	}
	useEffect(() => {
		setOnline(navigator.onLine);
		const sync = () => {
			setOnline(navigator.onLine);
			setNow(Date.now());
		};
		window.addEventListener("online", sync);
		window.addEventListener("offline", sync);
		return () => {
			window.removeEventListener("online", sync);
			window.removeEventListener("offline", sync);
		};
	}, []);
	useEffect(() => {
		if (connection.open) return;
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, [connection.open]);
	const text = reconnectingNotice({
		connection,
		everOpen: everOpen.current,
		droppedForMs: droppedAt.current === null ? 0 : now - droppedAt.current,
		online,
	});
	if (!text) return null;
	return (
		<p
			role="status"
			data-live-status
			className="fixed bottom-4 left-4 z-[240] rounded-md border bg-background px-3 py-1.5 text-muted-foreground text-xs shadow-sm"
		>
			{text}
		</p>
	);
}
