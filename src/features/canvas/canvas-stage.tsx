import {
	type ReactNode,
	useCallback,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type {
	CanvasElementPick,
	CanvasFrameMessage,
	CanvasRect,
} from "#/domain/canvas-annotation";
import { useCanvasBridge } from "./canvas-bridge";
import { CanvasFrame } from "./canvas-frame";

/** Space kept around a device frame on the stage. */
const STAGE_GUTTER = 32;
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

/** Where the frame's viewport is on the stage, and how much it is scaled. */
type FrameGeometry = {
	readonly left: number;
	readonly top: number;
	readonly scale: number;
};

type Box = { x: number; y: number; width: number; height: number };

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), Math.max(min, max));
}

/** An element's place on the stage, from its place in the canvas. */
function stageBox(rect: CanvasRect, frame: FrameGeometry): Box {
	return {
		x: frame.left + rect.x * frame.scale,
		y: frame.top + rect.y * frame.scale,
		width: rect.width * frame.scale,
		height: rect.height * frame.scale,
	};
}

/**
 * The preview, at the panel's width or a device width scaled to fit the
 * panel, with the app's overlay above it: numbered pins that follow their
 * elements as the canvas scrolls and resizes, and the note box beside the
 * pin being written. The overlay is the app's, outside the canvas.
 */
export function CanvasStage({
	html,
	title,
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
	deviceWidth: number | null;
	annotating: boolean;
	marks: readonly StageMark[];
	onPick?: (pick: CanvasElementPick) => void;
	onMarkClick?: (key: string) => void;
	onEscape?: () => void;
	onPrompt?: (text: string) => void;
	composer?: { readonly markKey: string; readonly node: ReactNode } | null;
}) {
	const stage = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [size, setSize] = useState<{ width: number; height: number } | null>(
		null,
	);
	const [geometry, setGeometry] = useState<FrameGeometry | null>(null);
	const selectors = marks.map((mark) => mark.selector);
	const selectorKey = selectors.join("\n");
	/** The canvas's last report, for the selectors it was asked about. */
	const [reported, setReported] = useState<{
		readonly key: string;
		readonly rects: readonly (CanvasRect | null)[];
	} | null>(null);
	const measure = useCallback(() => {
		const element = frame.current;
		const area = stage.current;
		if (!element || !area || !element.offsetWidth) return;
		const box = element.getBoundingClientRect();
		const origin = area.getBoundingClientRect();
		setGeometry({
			left: box.left - origin.left,
			top: box.top - origin.top,
			scale: box.width / element.offsetWidth,
		});
	}, []);
	const asked = useRef(selectorKey);
	asked.current = selectorKey;
	const onMessage = (message: CanvasFrameMessage) => {
		if (message.type === "rects") {
			measure();
			setReported({ key: asked.current, rects: message.rects });
		} else if (message.type === "pick") {
			if (annotating) onPick?.(message.pick);
		} else if (message.type === "escape") {
			if (annotating) onEscape?.();
		} else if (message.type === "prompt") {
			onPrompt?.(message.text);
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
	// A new size or scale moves every pin: measure, and ask again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run on layout changes.
	useLayoutEffect(() => {
		measure();
		sync();
	}, [size, deviceWidth, measure, sync]);
	const scale =
		deviceWidth && size
			? Math.min(1, (size.width - STAGE_GUTTER) / deviceWidth)
			: 1;
	const device = deviceWidth !== null;
	const boxes = new Map<string, Box>();
	if (geometry && size)
		marks.forEach((mark, index) => {
			const rect =
				reported?.key === selectorKey ? reported.rects[index] : mark.fallback;
			if (!rect) return;
			const box = stageBox(rect, geometry);
			// Scrolled out of view: no pin.
			if (box.y + box.height < 0 || box.y > size.height) return;
			boxes.set(mark.key, box);
		});
	const composerBox = composer ? boxes.get(composer.markKey) : undefined;
	return (
		<div
			ref={stage}
			className="canvas-stage"
			data-device={device ? "true" : undefined}
			data-annotating={annotating ? "true" : undefined}
		>
			<div
				className="canvas-device"
				style={
					device && size
						? {
								width: deviceWidth,
								height: (size.height - STAGE_GUTTER) / scale,
								transform: `scale(${scale})`,
							}
						: undefined
				}
			>
				<CanvasFrame
					html={html}
					title={title}
					className="canvas-frame"
					frameRef={frame}
					onLoad={() => {
						measure();
						sync();
					}}
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
		</div>
	);
}
