export function ClaudeMark({ size = 24 }: { size?: number }) {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth="1.5"
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
		>
			<circle cx="12" cy="12" r="8.25" />
			<path d="M15.25 8.5H11a2.75 2.75 0 0 0 0 5.5h2a2.25 2.25 0 0 1 0 4.5H8.75" />
		</svg>
	);
}
