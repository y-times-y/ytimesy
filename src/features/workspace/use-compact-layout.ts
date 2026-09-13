import { useEffect, useState } from "react";

export function useCompactLayout() {
	const [compact, setCompact] = useState(false);

	useEffect(() => {
		const query = window.matchMedia(
			"(max-width: 600px), (max-width: 900px) and (max-height: 500px)",
		);
		const update = () => setCompact(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return compact;
}
