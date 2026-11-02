import { FreestyleApiError } from "freestyle";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_WALLPAPER_B64_PATH } from "./desktop-wallpaper";
import {
	DESKTOP_THROWAWAY_CREDENTIALS,
	START_WORKSPACE_DESKTOP,
} from "./start-desktop";
import { prepareTemplateSnapshot } from "./template-snapshot";

function fakeVm(
	options: {
		storage?: number;
		resize?: () => Promise<unknown>;
		exec?: (command: string) => { statusCode: number; stderr?: string };
	} = {},
) {
	const calls: string[] = [];
	let storage = options.storage ?? 16384;
	const vm = {
		id: "vm-template",
		data: vi.fn(async () => ({
			resources: { cpu: 2, memory: 4096, storage },
		})),
		resize: vi.fn(async (target: { storage?: number }) => {
			calls.push(`resize ${JSON.stringify(target)}`);
			if (options.resize) await options.resize();
			storage = target.storage ?? storage;
			return {};
		}),
		exec: vi.fn(async ({ command }: { command: string }) => {
			calls.push(
				command === DESKTOP_THROWAWAY_CREDENTIALS
					? "exec throwaway credentials"
					: command === START_WORKSPACE_DESKTOP
						? "exec start desktop"
						: "exec other",
			);
			return options.exec?.(command) ?? { statusCode: 0, stdout: "" };
		}),
		fs: {
			writeTextFile: vi.fn(async (path: string) => {
				calls.push(`write ${path}`);
			}),
		},
	};
	return {
		vm: vm as unknown as Parameters<typeof prepareTemplateSnapshot>[0],
		calls,
	};
}

describe("prepareTemplateSnapshot", () => {
	it("grows only the disk to the project's size, and only when smaller", async () => {
		const small = fakeVm({ storage: 16384 });
		await prepareTemplateSnapshot(small.vm, { storageMiB: 32768 });
		// vCPU and memory stay: a copy cannot shrink, and they are what a smaller size saves.
		expect(small.calls).toEqual(['resize {"storage":32768}']);
		const sized = fakeVm({ storage: 32768 });
		await prepareTemplateSnapshot(sized.vm, { storageMiB: 32768 });
		expect(sized.calls).toEqual([]);
	});

	it("starts the desktop on credentials nobody holds, after the wallpaper", async () => {
		const { vm, calls } = fakeVm();
		await prepareTemplateSnapshot(vm, { desktop: true });
		expect(calls).toEqual([
			`write ${DESKTOP_WALLPAPER_B64_PATH}`,
			"exec throwaway credentials",
			"exec start desktop",
		]);
	});

	it("never fails the snapshot: a failed step is reported and skipped", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { vm, calls } = fakeVm({
			resize: async () => {
				throw new FreestyleApiError(
					400,
					{ code: "BAD_REQUEST", message: "too big" },
					"/resize",
				);
			},
			exec: (command) =>
				command === START_WORKSPACE_DESKTOP
					? { statusCode: 1, stderr: "no display" }
					: { statusCode: 0 },
		});
		await expect(
			prepareTemplateSnapshot(vm, { storageMiB: 65536, desktop: true }),
		).resolves.toEqual({
			skipped: expect.arrayContaining(["storage", "desktop"]),
		});
		expect(calls).toContain("exec start desktop");
		warn.mockRestore();
	});

	it("does not start a desktop when its private directory is refused", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { vm, calls } = fakeVm({
			exec: (command) =>
				command === DESKTOP_THROWAWAY_CREDENTIALS
					? { statusCode: 1, stderr: "refusing" }
					: { statusCode: 0 },
		});
		expect(await prepareTemplateSnapshot(vm, { desktop: true })).toEqual({
			skipped: ["desktop"],
		});
		expect(calls).not.toContain("exec start desktop");
		warn.mockRestore();
	});
});
