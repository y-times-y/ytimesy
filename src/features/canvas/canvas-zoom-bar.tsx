import {
	Check,
	ChevronDown,
	Maximize2,
	Minimize2,
	Minus,
	Plus,
	Scan,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { ZOOM_PRESETS } from "#/domain/canvas-viewport";

/**
 * The viewer's zoom controls, floating at the bottom of the stage: out, the
 * percentage with its presets (Fit, 50%, 100%, 200%), in, fit to panel, and
 * the expanded (full window) view.
 */
export function CanvasZoomBar({
	zoom,
	fitted,
	expanded,
	onZoomIn,
	onZoomOut,
	onPreset,
	onFit,
	onToggleExpanded,
}: {
	zoom: number;
	fitted: boolean;
	expanded: boolean;
	onZoomIn: () => void;
	onZoomOut: () => void;
	onPreset: (zoom: number) => void;
	onFit: () => void;
	onToggleExpanded: () => void;
}) {
	return (
		<div className="canvas-zoom-bar" role="toolbar" aria-label="Zoom">
			<button
				type="button"
				className="canvas-icon-button"
				aria-label="Zoom out"
				title="Zoom out (Ctrl/Cmd −)"
				onClick={onZoomOut}
			>
				<Minus size={14} strokeWidth={1.75} />
			</button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<button
						type="button"
						className="canvas-zoom-level"
						aria-label={`Zoom ${Math.round(zoom * 100)} percent`}
						title="Zoom presets"
					>
						<span>{Math.round(zoom * 100)}%</span>
						<ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
					</button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content
						className="recovery-menu inspector-view-menu canvas-zoom-menu"
						side="top"
						sideOffset={6}
						align="center"
					>
						<DropdownMenu.Item onSelect={onFit}>
							<span className="menu-row-label">Fit to panel</span>
							<span className="menu-row-check">
								{fitted ? <Check size={14} strokeWidth={1.5} /> : null}
							</span>
						</DropdownMenu.Item>
						{ZOOM_PRESETS.map((preset) => (
							<DropdownMenu.Item key={preset} onSelect={() => onPreset(preset)}>
								<span className="menu-row-label">{preset * 100}%</span>
								<span className="menu-row-check">
									{!fitted && Math.abs(zoom - preset) < 0.005 ? (
										<Check size={14} strokeWidth={1.5} />
									) : null}
								</span>
							</DropdownMenu.Item>
						))}
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
			<button
				type="button"
				className="canvas-icon-button"
				aria-label="Zoom in"
				title="Zoom in (Ctrl/Cmd +)"
				onClick={onZoomIn}
			>
				<Plus size={14} strokeWidth={1.75} />
			</button>
			<span className="canvas-zoom-divider" aria-hidden="true" />
			<button
				type="button"
				className="canvas-icon-button"
				aria-label="Fit to panel"
				aria-pressed={fitted}
				title="Fit to panel (Ctrl/Cmd 0)"
				onClick={onFit}
			>
				<Scan size={14} strokeWidth={1.75} />
			</button>
			<button
				type="button"
				className="canvas-icon-button"
				aria-label={expanded ? "Exit full view" : "Expand to full view"}
				title={expanded ? "Exit full view (Esc)" : "Expand to full view"}
				onClick={onToggleExpanded}
			>
				{expanded ? (
					<Minimize2 size={14} strokeWidth={1.75} />
				) : (
					<Maximize2 size={14} strokeWidth={1.75} />
				)}
			</button>
		</div>
	);
}
