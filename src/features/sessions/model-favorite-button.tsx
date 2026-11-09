import { Star } from "lucide-react";

export function ModelFavoriteButton({
	label,
	favorite,
	onToggle,
}: {
	label: string;
	favorite: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			className="model-favorite"
			aria-label={`${favorite ? "Unfavorite" : "Favorite"} ${label}`}
			aria-pressed={favorite}
			onClick={onToggle}
		>
			<Star size={16} fill={favorite ? "currentColor" : "none"} />
		</button>
	);
}

export type RenderModelFavorite = (
	id: string,
	label: string,
) => React.ReactNode;
