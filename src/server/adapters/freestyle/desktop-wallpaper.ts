import { deflateSync } from "node:zlib";

export const DESKTOP_WALLPAPER_WIDTH = 1440;
export const DESKTOP_WALLPAPER_HEIGHT = 900;
export const DESKTOP_WALLPAPER_BACKGROUND = [0x11, 0x11, 0x11] as const;
export const DESKTOP_WALLPAPER_B64_PATH = "/tmp/ytimesy-desktop-wallpaper.b64";

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

const MARK_VIEWBOX = 32;
const MARK_SIZE = 360;

const MARK_PATHS: readonly { fill: Rgb; polygon: readonly Point[] }[] = [
	{
		fill: [0xf2, 0xf2, 0xf0],
		polygon: [
			[4, 8],
			[10, 8],
			[10, 12],
			[16, 18],
			[22, 12],
			[22, 2],
			[28, 2],
			[28, 15],
			[19, 24],
			[19, 30],
			[13, 30],
			[13, 24],
			[4, 15],
		],
	},
	{
		fill: [0xa7, 0xa7, 0xa5],
		polygon: [
			[4, 15],
			[16, 22],
			[16, 30],
			[13, 30],
			[13, 24],
			[4, 15],
		],
	},
	{
		fill: [0xd0, 0xd0, 0xce],
		polygon: [
			[16, 22],
			[28, 15],
			[19, 24],
			[19, 30],
			[16, 30],
			[16, 22],
		],
	},
	{
		fill: [0xbc, 0xbc, 0xba],
		polygon: [
			[4, 8],
			[10, 12],
			[16, 18],
			[16, 22],
			[4, 15],
		],
	},
	{
		fill: [0xff, 0xff, 0xff],
		polygon: [
			[22, 12],
			[28, 2],
			[28, 15],
			[16, 22],
			[16, 18],
			[22, 12],
		],
	},
];

export function desktopWallpaperPixel(x: number, y: number): Rgb {
	const [bgR, bgG, bgB] = DESKTOP_WALLPAPER_BACKGROUND;
	const offsetX = (DESKTOP_WALLPAPER_WIDTH - MARK_SIZE) / 2;
	const offsetY = (DESKTOP_WALLPAPER_HEIGHT - MARK_SIZE) / 2;
	const scale = MARK_SIZE / MARK_VIEWBOX;
	const svgX = (x + 0.5 - offsetX) / scale;
	const svgY = (y + 0.5 - offsetY) / scale;
	if (svgX < 0 || svgX > MARK_VIEWBOX || svgY < 0 || svgY > MARK_VIEWBOX) {
		return DESKTOP_WALLPAPER_BACKGROUND;
	}
	let color: Rgb = [bgR, bgG, bgB];
	for (const path of MARK_PATHS) {
		if (pointInPolygon(svgX, svgY, path.polygon)) color = path.fill;
	}
	return color;
}

export function desktopWallpaperPng(): Buffer {
	const width = DESKTOP_WALLPAPER_WIDTH;
	const height = DESKTOP_WALLPAPER_HEIGHT;
	const rows = Buffer.alloc(height * (1 + width * 3));
	for (let y = 0; y < height; y += 1) {
		const row = y * (1 + width * 3);
		rows[row] = 0;
		for (let x = 0; x < width; x += 1) {
			const [r, g, b] = desktopWallpaperPixel(x, y);
			const i = row + 1 + x * 3;
			rows[i] = r;
			rows[i + 1] = g;
			rows[i + 2] = b;
		}
	}
	return encodePng(width, height, rows);
}

let cachedWallpaperBase64: string | undefined;

export function desktopWallpaperBase64(): string {
	cachedWallpaperBase64 ??= desktopWallpaperPng().toString("base64");
	return cachedWallpaperBase64;
}

function pointInPolygon(
	x: number,
	y: number,
	polygon: readonly Point[],
): boolean {
	let inside = false;
	for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
		const [xi, yi] = polygon[i] ?? [0, 0];
		const [xj, yj] = polygon[j] ?? [0, 0];
		if (yi === yj) continue;
		const crosses =
			yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
		if (crosses) inside = !inside;
	}
	return inside;
}

function encodePng(width: number, height: number, filtered: Buffer): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const idat = deflateSync(filtered, { level: 9 });
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngChunk(type: string, data: Buffer): Buffer {
	const typeBytes = Buffer.from(type, "ascii");
	const crc = crc32(Buffer.concat([typeBytes, data]));
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBytes.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc, 8 + data.length);
	return chunk;
}

function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}
