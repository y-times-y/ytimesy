import { useEffect, useState } from "react";

export function useCompactLayout(
	mediaQuery = "(max-width: 600px), (max-width: 900px) and (max-height: 500px)",
) {
	const [compact, setCompact] = useState(false);

	useEffect(() => {
		const query = window.matchMedia(mediaQuery);
		const update = () => setCompact(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, [mediaQuery]);

	return compact;
}
