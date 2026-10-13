interface ReasoningOptionProps {
	label: string;
	level: number;
	levelCount: number;
}

export function ReasoningOption({
	label,
	level,
	levelCount,
}: ReasoningOptionProps) {
	return (
		<span className="reasoning-option">
			<svg
				className="reasoning-bars size-4"
				viewBox={`0 0 ${levelCount * 5 + 1} 16`}
				fill="currentColor"
				aria-hidden="true"
			>
				{Array.from({ length: levelCount }, (_, index) => {
					const height =
						levelCount === 1 ? 13 : 5 + (index / (levelCount - 1)) * 8;
					return (
						<rect
							// biome-ignore lint/suspicious/noArrayIndexKey: Bars are fixed ordinal positions with no state or reordering.
							key={`bar-${index + 1}`}
							x={1 + index * 5}
							y={15 - height}
							width={3}
							height={height}
							rx={0.75}
							opacity={index < level ? 1 : 0.25}
						/>
					);
				})}
			</svg>
			<span>{label}</span>
		</span>
	);
}
