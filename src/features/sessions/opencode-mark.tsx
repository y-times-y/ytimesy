export function OpenCodeMark({ size = 24 }: { size?: number }) {
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
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}
