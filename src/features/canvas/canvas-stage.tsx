import {
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	CanvasElementPick,
	CanvasFrameMessage,
	CanvasRect,
} from "#/domain/canvas-annotation";
import {
	anchorBox,
	type Box,
	type CanvasView,
	constrainView,
	fitView,
	panBy,
	rememberedMode,
	rememberMode,
	stepZoom,
	type ViewMode,
	wheelZoomFactor,
	zoomAt,
} from "#/domain/canvas-viewport";
import { useCanvasBridge } from "./canvas-bridge";
import { CanvasFrame } from "./canvas-frame";
import { CanvasZoomBar } from "./canvas-zoom-bar";

/** The width a page is laid out at when the document brings no artboards. */
export const CANVAS_LAYOUT_WIDTH = 1280;
const LAYOUT_HEIGHT = 800;
/** The largest frame the viewer lays a document out in, per side. */
const FRAME_LIMIT = 16_000;
/** How long an unreported document is waited for before it is shown anyway. */
const REVEAL_FALLBACK_MS = 1500;
const PIN_SIZE = 22;
const COMPOSER_WIDTH = 288;
const COMPOSER_HEIGHT = 176;

/** A numbered pin on an element of the canvas. */
export type StageMark = {
	readonly key: string;
	readonly label: string;
	readonly selector: string;
	/** Where it was when picked, until the canvas reports where it is now. */
	readonly fallback: CanvasRect;
	/** Outlined: its note is being read or edited. */
	readonly active: boolean;
};

type Size = { readonly width: number; readonly height: number };

/** What the document last reported about its natural size. */
type SizeReport = {
	readonly layoutWidth: number;
	readonly bounds: CanvasRect | null;
	readonly width: number;
	readonly height: number;
};

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The stage that keyboard shortcuts act on: the one last used or entered. */
let activeStage: symbol | null = null;

function isTyping(target: EventTarget | null) {
	return (
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
	);
}

/**
 * The preview as a camera on the document: the sandboxed frame is laid out
 * at the document's natural size (its artboards, else its scroll size) and
 * moved and scaled by a CSS transform, so text stays sharp. It opens fitted
 * to the panel; wheel, pinch, keys and drags move the camera, and the user's
 * camera is remembered for the canvas. The app's overlay (numbered pins and
 * the note box) is placed with the same transform, so pins stay on their
 * elements. The overlay is the app's, outside the canvas.
 */
export function CanvasStage({
	html,
	title,
	canvasKey,
	deviceWidth,
	annotating,
	marks,
	onPick,
	onMarkClick,
	onEscape,
	onPrompt,
	composer,
}: {
	html: string;
	title: string;
	/** What the camera is remembered under: the canvas's title. */
	canvasKey: string;
	/** A device's layout width, or null for the wide default. */
	deviceWidth: number | null;
	annotating: boolean;
	marks: readonly StageMark[];
	onPick?: (pick: CanvasElementPick) => void;
	onMarkClick?: (key: string) => void;
	onEscape?: () => void;
	onPrompt?: (text: string) => void;
	composer?: { readonly markKey: string; readonly node: ReactNode } | null;
}) {
	const [menuHost, setMenuHost] = useState<HTMLElement | null>(null);
	const stage = useRef<HTMLDivElement | null>(null);
	const attachStage = useCallback((element: HTMLDivElement | null) => {
		stage.current = element;
		setMenuHost(element);
	}, []);
	const frame = useRef<HTMLIFrameElement>(null);
	const id = useRef(Symbol("canvas-stage"));
	const [size, setSize] = useState<Size | null>(null);
	const [report, setReport] = useState<SizeReport | null>(null);
	const [mode, setMode] = useState<ViewMode>(() => rememberedMode(canvasKey));
	const [revealed, setRevealed] = useState(false);
	const [expanded, setExpanded] = useState(false);
	const expandedNow = useRef(expanded);
	expandedNow.current = expanded;
	const [spaceDown, setSpaceDown] = useState(false);
	const [dragging, setDragging] = useState(false);
	const layoutWidth = deviceWidth ?? CANVAS_LAYOUT_WIDTH;
	const selectors = marks.map((mark) => mark.selector);
	const selectorKey = selectors.join("\n");
	/** The canvas's last report, for the selectors it was asked about. */
	const [reported, setReported] = useState<{
		readonly key: string;
		readonly rects: readonly (CanvasRect | null)[];
	} | null>(null);

	// The document laid out at its natural size, and the part of it to show.
	const live = report?.layoutWidth === layoutWidth ? report : null;
	const boundsRight = live?.bounds ? live.bounds.x + live.bounds.width : 0;
	const boundsBottom = live?.bounds ? live.bounds.y + live.bounds.height : 0;
	const frameSize: Size = {
		width: Math.min(
			FRAME_LIMIT,
			Math.max(layoutWidth, live?.width ?? 0, boundsRight),
		),
		height: Math.min(
			FRAME_LIMIT,
			Math.max(LAYOUT_HEIGHT, live?.height ?? 0, boundsBottom),
		),
	};
	const content: Box = live?.bounds ?? { x: 0, y: 0, ...frameSize };
	const view: CanvasView =
		mode.kind === "manual"
			? mode.view
			: size
				? fitView(content, size)
				: { zoom: 1, x: 0, y: 0 };
	const latest = useRef({ view, content, size });
	latest.current = { view, content, size };

	const setCamera = useCallback(
		(next: ViewMode) => {
			setMode(next);
			rememberMode(canvasKey, next);
		},
		[canvasKey],
	);
	const moveTo = useCallback(
		(next: CanvasView) => {
			const { content, size } = latest.current;
			const view = size ? constrainView(next, content, size) : next;
			// Events can arrive faster than renders: the next one starts here.
			latest.current = { ...latest.current, view };
			setCamera({ kind: "manual", view });
		},
		[setCamera],
	);
	const center = useCallback(() => {
		const { size } = latest.current;
		return { x: (size?.width ?? 0) / 2, y: (size?.height ?? 0) / 2 };
	}, []);
	const zoomTo = useCallback(
		(zoom: number) => moveTo(zoomAt(latest.current.view, zoom, center())),
		[moveTo, center],
	);
	const step = useCallback(
		(direction: 1 | -1) =>
			zoomTo(stepZoom(latest.current.view.zoom, direction)),
		[zoomTo],
	);
	const fit = useCallback(() => setCamera({ kind: "fit" }), [setCamera]);
	const wheel = useCallback(
		(w: {
			x: number;
			y: number;
			dx: number;
			dy: number;
			mode: number;
			zoom: boolean;
		}) => {
			const { view } = latest.current;
			if (w.zoom) {
				moveTo(
					zoomAt(view, view.zoom * wheelZoomFactor(w.dy, w.mode), {
						x: w.x,
						y: w.y,
					}),
				);
			} else {
				const lines = w.mode === 1 ? 16 : 1;
				moveTo(panBy(view, -w.dx * lines, -w.dy * lines));
			}
		},
		[moveTo],
	);

	const asked = useRef(selectorKey);
	asked.current = selectorKey;
	const onMessage = (message: CanvasFrameMessage) => {
		switch (message.type) {
			case "rects":
				setReported({ key: asked.current, rects: message.rects });
				break;
			case "size":
				setReport((current) =>
					current?.layoutWidth === layoutWidth &&
					current.width === message.width &&
					current.height === message.height &&
					JSON.stringify(current.bounds) === JSON.stringify(message.bounds)
						? current
						: {
								layoutWidth,
								bounds: message.bounds,
								width: message.width,
								height: message.height,
							},
				);
				break;
			case "pick":
				if (annotating) onPick?.(message.pick);
				break;
			case "escape":
				if (annotating) onEscape?.();
				break;
			case "prompt":
				onPrompt?.(message.text);
				break;
			case "wheel": {
				// The frame reports in its own coordinates: onto the stage.
				const { view } = latest.current;
				wheel({
					...message,
					x: view.x + message.x * view.zoom,
					y: view.y + message.y * view.zoom,
				});
				break;
			}
			case "zoomkey":
				activeStage = id.current;
				if (message.key === "reset") fit();
				else step(message.key === "in" ? 1 : -1);
				break;
			case "space":
				activeStage = id.current;
				setSpaceDown(message.down);
				break;
			case "pan":
				moveTo(panBy(latest.current.view, message.dx, message.dy));
				break;
		}
	};
	const sync = useCanvasBridge(frame, {
		annotating,
		selectors,
		onMessage,
	});

	useLayoutEffect(() => {
		const element = stage.current;
		if (!element) return;
		const update = () =>
			setSize({ width: element.clientWidth, height: element.clientHeight });
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// Expanded is the browser's full screen (the panel sits inside containers
	// a fixed element cannot leave); without it the stage fills the window.
	useEffect(() => {
		const element = stage.current;
		const onChange = () => setExpanded(document.fullscreenElement === element);
		document.addEventListener("fullscreenchange", onChange);
		return () => document.removeEventListener("fullscreenchange", onChange);
	}, []);
	const toggleExpanded = () => {
		const element = stage.current;
		if (!element) return;
		if (expandedNow.current) {
			if (document.fullscreenElement === element)
				void document.exitFullscreen();
			else setExpanded(false);
		} else if (element.requestFullscreen) {
			element.requestFullscreen().catch(() => setExpanded(true));
		} else setExpanded(true);
	};

	// Shown once placed (no jump from the unplaced frame), or after a wait.
	useEffect(() => {
		if (revealed) return;
		if (size && live) {
			setRevealed(true);
			return;
		}
		const timer = window.setTimeout(
			() => setRevealed(true),
			REVEAL_FALLBACK_MS,
		);
		return () => window.clearTimeout(timer);
	}, [revealed, size, live]);

	// Trackpad pinch arrives as Ctrl+wheel: it must not zoom the whole page.
	useEffect(() => {
		const element = stage.current;
		if (!element) return;
		const onWheel = (event: WheelEvent) => {
			if ((event.target as Element).closest?.(".canvas-composer")) return;
			event.preventDefault();
			const box = element.getBoundingClientRect();
			wheel({
				x: event.clientX - box.left,
				y: event.clientY - box.top,
				dx: event.deltaX,
				dy: event.deltaY,
				mode: event.deltaMode,
				zoom: event.ctrlKey || event.metaKey,
			});
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [wheel]);

	// Keys act on the stage last used (two stages exist while comparing).
	const stageId = id.current;
	const annotatingNow = useRef(annotating);
	annotatingNow.current = annotating;
	useEffect(() => {
		activeStage = stageId;
		const onKeyDown = (event: KeyboardEvent) => {
			if (activeStage !== stageId) return;
			if (event.key === "Escape") {
				if (
					expandedNow.current &&
					!annotatingNow.current &&
					!event.defaultPrevented
				)
					setExpanded(false);
				return;
			}
			if (isTyping(event.target)) return;
			if ((event.ctrlKey || event.metaKey) && !event.altKey) {
				const zoomIn = event.key === "+" || event.key === "=";
				const zoomOut = event.key === "-" || event.key === "_";
				if (!zoomIn && !zoomOut && event.key !== "0") return;
				event.preventDefault();
				if (event.key === "0") fit();
				else step(zoomIn ? 1 : -1);
			} else if (
				event.key === " " &&
				!(event.target instanceof HTMLButtonElement)
			) {
				event.preventDefault();
				setSpaceDown(true);
			}
		};
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key === " ") setSpaceDown(false);
		};
		const release = () => setSpaceDown(false);
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("keyup", onKeyUp);
		window.addEventListener("blur", release);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("keyup", onKeyUp);
			window.removeEventListener("blur", release);
			if (activeStage === stageId) activeStage = null;
		};
	}, [stageId, fit, step]);

	const drag = useRef<{ x: number; y: number } | null>(null);
	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const target = event.target as Element;
		if (
			target.closest(".canvas-composer-anchor, .canvas-zoom-bar, .canvas-pin")
		)
			return;
		const onBackground = event.target === event.currentTarget;
		if (
			!(
				event.button === 1 ||
				(event.button === 0 && (spaceDown || onBackground))
			)
		)
			return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		drag.current = { x: event.clientX, y: event.clientY };
		setDragging(true);
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (!drag.current) return;
		const dx = event.clientX - drag.current.x;
		const dy = event.clientY - drag.current.y;
		drag.current = { x: event.clientX, y: event.clientY };
		moveTo(panBy(latest.current.view, dx, dy));
	};
	const endDrag = () => {
		drag.current = null;
		setDragging(false);
	};

	const boxes = new Map<string, Box>();
	if (size && revealed)
		marks.forEach((mark, index) => {
			const rect =
				reported?.key === selectorKey ? reported.rects[index] : mark.fallback;
			if (!rect) return;
			const box = anchorBox(rect, view);
			// Panned or zoomed out of view: no pin.
			if (
				box.y + box.height < 0 ||
				box.y > size.height ||
				box.x + box.width < 0 ||
				box.x > size.width
			)
				return;
			boxes.set(mark.key, box);
		});
	const composerBox = composer ? boxes.get(composer.markKey) : undefined;
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: dragging pans; the zoom bar and keys do the same by keyboard.
		<div
			ref={attachStage}
			className="canvas-stage"
			data-annotating={annotating ? "true" : undefined}
			data-expanded={expanded ? "true" : undefined}
			data-pan={dragging ? "dragging" : spaceDown ? "ready" : undefined}
			onPointerEnter={() => {
				activeStage = id.current;
			}}
			onPointerDown={(event) => {
				activeStage = id.current;
				onPointerDown(event);
			}}
			onMouseDown={(event) => {
				if (event.button === 1) event.preventDefault();
			}}
			onPointerMove={onPointerMove}
			onPointerUp={endDrag}
			onPointerCancel={endDrag}
		>
			<div
				className="canvas-world"
				data-revealed={revealed ? "true" : undefined}
				style={{
					width: frameSize.width,
					height: frameSize.height,
					transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
				}}
			>
				<CanvasFrame
					html={html}
					title={title}
					className="canvas-frame"
					frameRef={frame}
					fixed
					onLoad={sync}
				/>
			</div>
			{size && (boxes.size || composer) ? (
				<div className="canvas-overlay">
					{marks.map((mark) => {
						const box = boxes.get(mark.key);
						if (!box) return null;
						return (
							<div key={mark.key}>
								{mark.active ? (
									<div
										className="canvas-mark-outline"
										style={{
											left: box.x - 2,
											top: box.y - 2,
											width: box.width + 4,
											height: box.height + 4,
										}}
									/>
								) : null}
								<button
									type="button"
									className="canvas-pin"
									data-active={mark.active ? "true" : undefined}
									aria-label={`Note ${mark.label}`}
									style={{
										left: clamp(
											box.x - PIN_SIZE / 2,
											4,
											size.width - PIN_SIZE - 4,
										),
										top: clamp(
											box.y - PIN_SIZE / 2,
											4,
											size.height - PIN_SIZE - 4,
										),
									}}
									onClick={() => onMarkClick?.(mark.key)}
								>
									{mark.label}
								</button>
							</div>
						);
					})}
					{composer ? (
						<div
							className="canvas-composer-anchor"
							style={
								composerBox
									? {
											left: clamp(
												composerBox.x,
												8,
												size.width - COMPOSER_WIDTH - 8,
											),
											top:
												composerBox.y +
													composerBox.height +
													10 +
													COMPOSER_HEIGHT <
												size.height
													? composerBox.y + composerBox.height + 10
													: clamp(
															composerBox.y - COMPOSER_HEIGHT - 10,
															8,
															size.height - COMPOSER_HEIGHT - 8,
														),
										}
									: // Its element is out of view: the box sits at the bottom.
										{
											left: clamp(
												(size.width - COMPOSER_WIDTH) / 2,
												8,
												size.width,
											),
											bottom: 12,
										}
							}
						>
							{composer.node}
						</div>
					) : null}
				</div>
			) : null}
			<CanvasZoomBar
				zoom={view.zoom}
				fitted={mode.kind === "fit"}
				expanded={expanded}
				onZoomIn={() => step(1)}
				onZoomOut={() => step(-1)}
				onPreset={zoomTo}
				onFit={fit}
				onToggleExpanded={toggleExpanded}
				menuHost={menuHost}
			/>
		</div>
	);
}
