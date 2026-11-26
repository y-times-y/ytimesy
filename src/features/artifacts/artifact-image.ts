/**
 * An artifact's static SVG (artifactSvg) as a 2x PNG, drawn in the browser:
 * nothing is uploaded. The SVG loads as an image from a blob URL, so it
 * cannot run script or fetch anything.
 */
export async function artifactPngBlob(svg: string): Promise<Blob> {
	const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
	try {
		const image = new Image();
		await new Promise<void>((resolve, reject) => {
			image.onload = () => resolve();
			image.onerror = () =>
				reject(new Error("The artifact image did not load."));
			image.src = url;
		});
		const scale = 2;
		const canvas = document.createElement("canvas");
		canvas.width = image.naturalWidth * scale;
		canvas.height = image.naturalHeight * scale;
		const context = canvas.getContext("2d");
		if (!context) throw new Error("No canvas to draw on.");
		context.scale(scale, scale);
		context.drawImage(image, 0, 0);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) => (blob ? resolve(blob) : reject(new Error("No image made."))),
				"image/png",
			),
		);
	} finally {
		URL.revokeObjectURL(url);
	}
}

/** Puts the PNG on the clipboard; false where the browser cannot (the caller then downloads it). */
export async function copyPng(blob: Blob): Promise<boolean> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
		return false;
	try {
		await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		return true;
	} catch {
		return false;
	}
}

export function downloadPng(blob: Blob, name: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `${name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "artifact"}.png`;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
