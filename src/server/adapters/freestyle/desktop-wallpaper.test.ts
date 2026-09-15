import { describe, expect, it } from "vitest";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	DESKTOP_WALLPAPER_BACKGROUND,
	DESKTOP_WALLPAPER_HEIGHT,
	DESKTOP_WALLPAPER_WIDTH,
	desktopWallpaperBase64,
	desktopWallpaperPixel,
	desktopWallpaperPng,
} from "./desktop-wallpaper";

describe("desktopWallpaperPng", () => {
	it("encodes a 1440×900 charcoal wallpaper with the ytimesy mark in the center", () => {
		const png = desktopWallpaperPng();
		expect([...png.subarray(0, 8)]).toEqual([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		]);
		expect(png.readUInt32BE(16)).toBe(DESKTOP_WALLPAPER_WIDTH);
		expect(png.readUInt32BE(20)).toBe(DESKTOP_WALLPAPER_HEIGHT);
		expect(desktopWallpaperPixel(0, 0)).toEqual([
			...DESKTOP_WALLPAPER_BACKGROUND,
		]);
		expect(
			desktopWallpaperPixel(
				DESKTOP_WALLPAPER_WIDTH - 1,
				DESKTOP_WALLPAPER_HEIGHT - 1,
			),
		).toEqual([...DESKTOP_WALLPAPER_BACKGROUND]);
		expect(desktopWallpaperPixel(720, 520)).not.toEqual([
			...DESKTOP_WALLPAPER_BACKGROUND,
		]);
	});

	it("writes a guest payload the start script can decode", () => {
		const encoded = desktopWallpaperBase64();
		expect(DESKTOP_WALLPAPER_B64_PATH).toBe(
			"/tmp/ytimesy-desktop-wallpaper.b64",
		);
		expect(Buffer.from(encoded, "base64").subarray(0, 8)).toEqual(
			desktopWallpaperPng().subarray(0, 8),
		);
	});
});
