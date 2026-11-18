import { MeshGradient } from "@paper-design/shaders-react";
import { createRoot } from "react-dom/client";

// One smooth mesh gradient per palette and variant: no grain, no dithering.
// Keep PALETTES in the order of THREAD_ART_PALETTES (src/domain/thread-art.ts).
const PALETTES = [
	["#1b1464", "#5b2bd6", "#d946ef", "#ff7ab6", "#ffd1a6"], // dusk
	["#2a0a12", "#c2185b", "#ff4d2e", "#ff9a3c", "#ffe0a3"], // ember
	["#04121f", "#0b5fff", "#00c2d1", "#7df9e0", "#e6fff6"], // lagoon
	["#062016", "#0f8a5f", "#38d27a", "#c7f464", "#fff8c2"], // meadow
	["#1a0833", "#6d28d9", "#c026d3", "#f472b6", "#fde4f2"], // orchid
	["#3a1c00", "#f59e0b", "#ffd23f", "#ff7a45", "#fff3c4"], // citrus
	["#0a1030", "#3b5bdb", "#74c0fc", "#d0ebff", "#ffffff"], // glacier
	["#2b0a1f", "#9d174d", "#fb7185", "#fdba74", "#ffe4e6"], // rosewood
	["#3b1230", "#ff6b6b", "#ffa07a", "#ffd6a5", "#fff1e6"], // peach
	["#05050f", "#1e1b4b", "#4338ca", "#38bdf8", "#e0f2fe"], // midnight
	["#1f0a3d", "#7c3aed", "#fb5b8d", "#ffb347", "#fff0b3"], // sunrise
];
const OFFSET_X = [-0.1, 0.15, -0.2, 0.2];
const OFFSET_Y = [0.1, -0.1, 0.2, -0.2];

const query = new URLSearchParams(location.search);
const palette = Number(query.get("palette"));
const variant = Number(query.get("variant"));

createRoot(document.getElementById("root")).render(
	<div id="tile" style={{ width: 64, height: 64 }}>
		<MeshGradient
			width={64}
			height={64}
			colors={PALETTES[palette]}
			distortion={0.9}
			swirl={0.6}
			grainMixer={0}
			grainOverlay={0}
			speed={0}
			frame={1500 + variant * 2300 + palette * 370}
			rotation={variant * 140 + palette * 29}
			scale={1.15}
			offsetX={OFFSET_X[variant]}
			offsetY={OFFSET_Y[variant]}
		/>
	</div>,
);
