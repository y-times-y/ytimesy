import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("./memory.fn", () => ({
	readMemoryModeFn: async () => ({ available: true, mode: "full" }),
	saveMemoryModeFn: async () => undefined,
}));
const { MemorySettingsView } = await import("./memory-settings");

it("shows Use memory as a switch with what off means", () => {
	const on = renderToStaticMarkup(
		<MemorySettingsView on available onChange={() => {}} />,
	);
	expect(on).toContain(">Use memory</label>");
	expect(on).toMatch(/role="switch"[^>]*aria-checked="true"/);
	expect(on).toContain(
		"nothing is recalled into chats and nothing new is saved",
	);
	const off = renderToStaticMarkup(
		<MemorySettingsView on={false} available onChange={() => {}} />,
	);
	expect(off).toMatch(/role="switch"[^>]*aria-checked="false"/);
});
