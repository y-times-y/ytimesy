import type { Vm } from "freestyle";
import { FreestyleApiError } from "freestyle";
import {
	DESKTOP_WALLPAPER_B64_PATH,
	desktopWallpaperBase64,
} from "./desktop-wallpaper";
import {
	DESKTOP_THROWAWAY_CREDENTIALS,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";
import { resizeLands } from "./workspace-machines";

/**
 * What a project template is given before Freestyle captures it. A snapshot
 * holds memory and disk, so every chat copied from it resumes exactly this
 * state (https://www.freestyle.sh/docs/vms/base-snapshots#custom-snapshots).
 */
export type TemplateSnapshotPreparation = {
	/**
	 * Grow the disk to this size first. Copies start at their snapshot's size
	 * and growing a disk is the slow part of a copy's resize (0.4-4 s on dev;
	 * vCPU and memory take ~80 ms), so a template already at the project's
	 * disk size spares every new chat that wait. vCPU and memory stay as they
	 * are: a copy cannot shrink, and they are what a smaller size saves.
	 */
	readonly storageMiB?: number;
	/**
	 * Start the desktop (X display, window manager, dock, VNC server and its
	 * viewer proxy) so copies resume it running, as Freestyle's desktop guides
	 * do. It runs on throwaway credentials nobody holds: a copy's first
	 * Desktop open drops its own, which both servers read per connection, so
	 * nothing restarts there.
	 */
	readonly desktop?: boolean;
};

/** One step of preparing the template; a failed step only costs copies the speedup. */
type Step = "storage" | "desktop";

/**
 * Prepares a running template for its snapshot. Never throws: each step is
 * an optimisation, and the snapshot is taken either way (a copy then grows
 * its disk or starts its desktop itself, as before).
 */
export async function prepareTemplateSnapshot(
	vm: Pick<Vm, "id" | "data" | "resize" | "exec" | "fs">,
	preparation: TemplateSnapshotPreparation,
): Promise<{ readonly skipped: readonly Step[] }> {
	const skipped: Step[] = [];
	await Promise.all([
		preparation.storageMiB
			? growTemplateDisk(vm, preparation.storageMiB).catch((cause) => {
					skipped.push("storage");
					console.warn("Template disk was not grown before its snapshot.", {
						message: messageOf(cause),
					});
				})
			: undefined,
		preparation.desktop
			? startTemplateDesktop(vm).catch((cause) => {
					skipped.push("desktop");
					console.warn(
						"Template desktop was not started before its snapshot.",
						{
							message: messageOf(cause),
						},
					);
				})
			: undefined,
	]);
	return { skipped };
}

async function growTemplateDisk(
	vm: Pick<Vm, "data" | "resize">,
	storageMiB: number,
) {
	const { resources } = await vm.data();
	if (resources.storage >= storageMiB) return;
	const target = { ...resources, storage: storageMiB };
	await vm.resize({ storage: storageMiB }).catch(async (error) => {
		// As for a copy: a 5xx often means the grow is still finishing.
		if (
			!(error instanceof FreestyleApiError && error.status >= 500) ||
			!(await resizeLands(vm, target))
		)
			throw error;
	});
}

async function startTemplateDesktop(vm: Pick<Vm, "exec" | "fs">) {
	await vm.fs.writeTextFile(
		DESKTOP_WALLPAPER_B64_PATH,
		desktopWallpaperBase64(),
	);
	const credentials = await vm.exec({
		command: DESKTOP_THROWAWAY_CREDENTIALS,
		timeoutMs: 15_000,
	});
	if (credentials.statusCode !== 0)
		throw new Error(
			`throwaway credentials failed: ${(credentials.stderr ?? "").slice(-200)}`,
		);
	const started = await vm.exec({
		command: START_WORKSPACE_DESKTOP,
		timeoutMs: 120_000,
	});
	if (started.statusCode !== 0)
		throw new Error(
			`desktop start failed: ${(started.stderr ?? "").slice(-300)}`,
		);
}

function messageOf(cause: unknown) {
	return cause instanceof Error ? cause.message.slice(0, 200) : "unknown";
}
