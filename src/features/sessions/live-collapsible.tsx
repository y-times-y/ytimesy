import {
	type DetailsHTMLAttributes,
	type ReactNode,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import {
	liveCollapsibleIsOpen,
	openedByUserAfterLiveChange,
	openedByUserFromToggle,
} from "#/domain/live-collapsible";
import { RenderFoldedBodies, summaryAndBody } from "./lazy-details";

export function LiveCollapsible({
	live,
	children,
	...props
}: {
	live: boolean;
	children: ReactNode;
} & Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "open" | "onToggle">) {
	const [openedByUser, setOpenedByUser] = useState(false);
	const wasLive = useRef(live);
	const open = liveCollapsibleIsOpen(live, openedByUser);
	// Folded, only its summary renders (lazy-details.tsx); once shown, the rest stays.
	const [shown, setShown] = useState(open);
	if (open && !shown) setShown(true);
	const always = useContext(RenderFoldedBodies);

	useEffect(() => {
		setOpenedByUser((current) =>
			openedByUserAfterLiveChange(live, wasLive.current, current),
		);
		wasLive.current = live;
	}, [live]);

	return (
		<details
			{...props}
			open={open}
			onClickCapture={(event) => {
				if (
					event.target instanceof Element &&
					event.target.closest("summary")?.parentElement === event.currentTarget
				)
					setShown(true);
			}}
			onToggle={(event) => {
				const nextOpen = event.currentTarget.open;
				if (nextOpen) setShown(true);
				setOpenedByUser((current) =>
					openedByUserFromToggle(live, nextOpen, current),
				);
			}}
		>
			{summaryAndBody(children, always || shown)}
		</details>
	);
}
