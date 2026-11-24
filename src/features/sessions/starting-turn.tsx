import { useEffect, useId, useState } from "react";

const WAIT_MS = 20_000;
const WAITING = "Still waiting for the first response or step…";
const STARTING = "Starting…";

export function remainingStartWait(startedAt: number | undefined, now: number) {
	return startedAt === undefined || !Number.isFinite(startedAt)
		? undefined
		: Math.max(0, startedAt + WAIT_MS - now);
}

export function scheduleStartingTurnWait(
	startedAt: number | undefined,
	now: number,
	setWaiting: (waiting: boolean) => void,
) {
	const remaining = remainingStartWait(startedAt, now);
	setWaiting(remaining === 0);
	if (remaining === 0) return;
	const timer = setTimeout(() => setWaiting(true), remaining ?? WAIT_MS);
	return () => clearTimeout(timer);
}

// Runs during parsing, before paint. Keep its threshold and text in sync above.
function prepareStartingTurn(id: string, startedAt: number | null) {
	const element = document.getElementById(id);
	if (element && startedAt !== null && Date.now() - startedAt >= 20_000) {
		element.textContent = "Still waiting for the first response or step…";
		element.className = "session-working";
	}
}

export function StartingTurn({ startedAt }: { startedAt?: number }) {
	const id = useId();
	const [waiting, setWaiting] = useState(() => {
		if (typeof document === "undefined") return false;
		const existing = document.getElementById(id);
		return existing
			? existing.textContent === WAITING
			: remainingStartWait(startedAt, Date.now()) === 0;
	});
	useEffect(() => {
		return scheduleStartingTurnWait(startedAt, Date.now(), setWaiting);
	}, [startedAt]);
	return (
		<>
			<p
				id={id}
				className={
					waiting ? "session-working" : "session-working session-shimmer"
				}
				role="status"
			>
				{waiting ? WAITING : STARTING}
			</p>
			<script
				// biome-ignore lint/security/noDangerouslySetInnerHtml: the script contains only a React-generated id and a numeric timestamp.
				dangerouslySetInnerHTML={{
					__html: `(${prepareStartingTurn.toString()})(${JSON.stringify(id)},${JSON.stringify(Number.isFinite(startedAt) ? startedAt : null)})`,
				}}
			/>
		</>
	);
}
