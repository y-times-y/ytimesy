import {
	Children,
	createContext,
	type DetailsHTMLAttributes,
	isValidElement,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

/** Folded bodies render too (tests that read a whole transcript's markup). */
export const RenderFoldedBodies = createContext(false);

/**
 * A <details> that renders only its <summary> until it is first opened:
 * a long chat's folded tool output, commands and briefs cost nothing to
 * render, hydrate or lay out until the reader asks for them. It opens on
 * the summary's click (before the browser paints the open state), and on
 * any other toggle (the browser's find, a click before hydration).
 */
export function LazyDetails({
	children,
	onToggle,
	onClickCapture,
	...props
}: DetailsHTMLAttributes<HTMLDetailsElement>) {
	const ref = useRef<HTMLDetailsElement>(null);
	const [opened, setOpened] = useState(Boolean(props.open));
	const always = useContext(RenderFoldedBodies);
	useLayoutEffect(() => {
		if (ref.current?.open) setOpened(true);
	}, []);
	return (
		<details
			{...props}
			ref={ref}
			onClickCapture={(event) => {
				if (
					!opened &&
					event.target instanceof Element &&
					event.target.closest("summary")?.parentElement === event.currentTarget
				)
					setOpened(true);
				onClickCapture?.(event);
			}}
			onToggle={(event) => {
				if (event.currentTarget.open) setOpened(true);
				onToggle?.(event);
			}}
		>
			{summaryAndBody(children, always || opened || Boolean(props.open))}
		</details>
	);
}

/** The <summary> child, and the other children when `withBody`. */
export function summaryAndBody(children: ReactNode, withBody: boolean) {
	if (withBody) return children;
	return Children.toArray(children).filter(
		(child) => isValidElement(child) && child.type === "summary",
	);
}
