import type { CaptainStatus } from "#/domain/captain";

/** The captain's mark: its colour with its first letter, a hat for the leader, a status dot. */
export function CaptainAvatar({
	name,
	color,
	size = 24,
	leader = false,
	status,
}: {
	name: string;
	color: string;
	size?: number;
	leader?: boolean;
	status?: CaptainStatus;
}) {
	return (
		<span
			className="captain-avatar"
			data-leader={leader || undefined}
			style={{
				width: size,
				height: size,
				background: color,
				fontSize: Math.round(size * 0.46),
			}}
			aria-hidden="true"
		>
			{Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
			{leader ? (
				<svg
					className="captain-hat"
					viewBox="0 0 16 16"
					width="12"
					height="12"
					aria-hidden="true"
				>
					<path d="M2 11h12l-1.2-5L8 8 3.2 6z" fill="currentColor" />
					<circle cx="8" cy="4.6" r="1.3" fill="currentColor" />
				</svg>
			) : null}
			{status ? <i className="captain-dot" data-status={status} /> : null}
		</span>
	);
}
