export function SixDotSpinner() {
	return (
		<span className="six-dot-spinner" aria-hidden="true">
			{["a", "b", "c", "d", "e", "f"].map((position) => (
				<i key={position} />
			))}
		</span>
	);
}
