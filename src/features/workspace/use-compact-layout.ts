import { useEffect, useState } from "react";
import { COMPACT_LAYOUT_QUERY } from "../app/first-paint";

/** Whether the viewport is phone-sized, starting from what the first paint used. */
export function useCompactLayout(initial: boolean) {
	const [compact, setCompact] = useState(initial);

	useEffect(() => {
		const query = window.matchMedia(COMPACT_LAYOUT_QUERY);
		const update = () => setCompact(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return compact;
}
