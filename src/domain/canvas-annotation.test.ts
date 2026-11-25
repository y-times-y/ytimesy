import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
	annotateMessage,
	CANVAS_BRIDGE_SCRIPT,
	CANVAS_NOTES_LIMIT,
	CANVAS_PROMPT_LIMIT,
	type CanvasNote,
	canvasElementLabel,
	canvasFeedbackMessage,
	canvasFeedbackOwner,
	canvasFrameMessage,
	canvasMessageFromFrame,
	cleanCanvasText,
	trackMessage,
} from "./canvas-annotation";

const rect = { x: 10, y: 20, width: 120, height: 36 };
const pick = {
	type: "ytimesy-canvas:pick",
	selector: "#plan-pro > button",
	tag: "BUTTON",
	text: "Choose Pro",
	rect,
};
const frame = { name: "canvas frame" };

describe("canvasMessageFromFrame", () => {
	it("takes a pick from the canvas's own frame after a click", () => {
		expect(
			canvasMessageFromFrame({ source: frame, data: pick }, frame, true),
		).toEqual({
			type: "pick",
			pick: {
				selector: "#plan-pro > button",
				tag: "button",
				text: "Choose Pro",
				rect,
			},
		});
	});

	it("rejects messages from any other source", () => {
		for (const source of [null, undefined, {}, { name: "canvas frame" }])
			expect(
				canvasMessageFromFrame({ source, data: pick }, frame, true),
			).toBeNull();
		// No frame (not loaded or gone): nothing is accepted.
		expect(
			canvasMessageFromFrame({ source: null, data: pick }, null, true),
		).toBeNull();
	});

	it("needs a real click for pins and prompts, not for positions", () => {
		const prompt = { type: "ytimesy-canvas:prompt", text: "Go with option B" };
		expect(
			canvasMessageFromFrame({ source: frame, data: pick }, frame, false),
		).toBeNull();
		expect(
			canvasMessageFromFrame({ source: frame, data: prompt }, frame, false),
		).toBeNull();
		expect(
			canvasMessageFromFrame(
				{
					source: frame,
					data: { type: "ytimesy-canvas:rects", rects: [rect] },
				},
				frame,
				false,
			),
		).toEqual({ type: "rects", rects: [rect] });
	});
});

describe("viewer messages", () => {
	const wheel = {
		type: "ytimesy-canvas:wheel",
		x: 10,
		y: 20,
		dx: 0,
		dy: -4,
		mode: 0,
		zoom: true,
	};
	it("accepts the document's size, with or without artboards", () => {
		expect(
			canvasFrameMessage({
				type: "ytimesy-canvas:size",
				bounds: rect,
				width: 3000,
				height: 900,
			}),
		).toEqual({ type: "size", bounds: rect, width: 3000, height: 900 });
		expect(
			canvasFrameMessage({
				type: "ytimesy-canvas:size",
				bounds: null,
				width: 1280,
				height: 800,
			}),
		).toEqual({ type: "size", bounds: null, width: 1280, height: 800 });
	});
	it("accepts wheel, zoom key, space and pan", () => {
		expect(canvasFrameMessage(wheel)).toMatchObject({
			type: "wheel",
			zoom: true,
		});
		expect(
			canvasFrameMessage({ type: "ytimesy-canvas:zoomkey", key: "reset" }),
		).toEqual({ type: "zoomkey", key: "reset" });
		expect(
			canvasFrameMessage({ type: "ytimesy-canvas:space", down: true }),
		).toEqual({ type: "space", down: true });
		expect(
			canvasFrameMessage({ type: "ytimesy-canvas:pan", dx: -3, dy: 4 }),
		).toEqual({ type: "pan", dx: -3, dy: 4 });
	});
	it("rejects malformed viewer messages", () => {
		const malformed: unknown[] = [
			{ type: "ytimesy-canvas:size", bounds: rect, width: -1, height: 5 },
			{ type: "ytimesy-canvas:size", bounds: { x: 1 }, width: 5, height: 5 },
			{ type: "ytimesy-canvas:size", width: 5, height: 5 },
			{ ...wheel, mode: 7 },
			{ ...wheel, zoom: "yes" },
			{ ...wheel, dy: Number.NaN },
			{ type: "ytimesy-canvas:zoomkey", key: "sideways" },
			{ type: "ytimesy-canvas:space", down: 1 },
			{ type: "ytimesy-canvas:pan", dx: 1 },
		];
		for (const data of malformed) expect(canvasFrameMessage(data)).toBeNull();
	});
});

describe("canvasFrameMessage", () => {
	it("rejects malformed messages", () => {
		const malformed: unknown[] = [
			null,
			"ytimesy-canvas:pick",
			[pick],
			{ ...pick, type: "ytimesy-canvas:run" },
			{ ...pick, extra: true },
			{ ...pick, selector: 1 },
			{ ...pick, selector: "   " },
			{ ...pick, tag: "button onclick" },
			{ ...pick, rect: { ...rect, width: -1 } },
			{ ...pick, rect: { ...rect, x: Number.NaN } },
			{ ...pick, rect: { ...rect, y: Number.POSITIVE_INFINITY } },
			{ ...pick, rect: { ...rect, z: 1 } },
			{ type: "ytimesy-canvas:prompt" },
			{ type: "ytimesy-canvas:prompt", text: 5 },
			{ type: "ytimesy-canvas:prompt", text: "\u0000\u200e " },
			{ type: "ytimesy-canvas:rects", rects: [rect, "x"] },
			{ type: "ytimesy-canvas:rects", rects: {} },
			{ type: "ytimesy-canvas:escape", now: true },
			Object.assign(Object.create({ inherited: true }), {
				type: "ytimesy-canvas:escape",
			}),
		];
		for (const data of malformed) expect(canvasFrameMessage(data)).toBeNull();
	});

	it("rejects oversized fields instead of trimming them", () => {
		expect(
			canvasFrameMessage({
				type: "ytimesy-canvas:prompt",
				text: "x".repeat(CANVAS_PROMPT_LIMIT + 1),
			}),
		).toBeNull();
		expect(canvasFrameMessage({ ...pick, text: "x".repeat(121) })).toBeNull();
		expect(
			canvasFrameMessage({ ...pick, selector: "a".repeat(301) }),
		).toBeNull();
		expect(
			canvasFrameMessage({
				type: "ytimesy-canvas:rects",
				rects: Array.from({ length: CANVAS_NOTES_LIMIT + 1 }, () => null),
			}),
		).toBeNull();
		expect(
			canvasFrameMessage({ ...pick, rect: { ...rect, x: 2_000_000 } }),
		).toBeNull();
	});

	it("strips control and bidirectional characters from a prompt", () => {
		expect(
			canvasFrameMessage({
				type: "ytimesy-canvas:prompt",
				text: "  Go with\u0007 option \u202eB\u202c\r\n\n\n\nnow\t ",
			}),
		).toEqual({ type: "prompt", text: "Go with option B\n\nnow" });
		expect(cleanCanvasText("a\u0000b\u009fc\u2066d\ufeff")).toBe("abcd");
	});
});

describe("canvasFeedbackMessage", () => {
	const notes: CanvasNote[] = [
		{
			id: "1",
			pick: {
				selector: "#plan-pro > button",
				tag: "button",
				text: "Choose Pro",
				rect,
			},
			note: "Make it green",
		},
		{
			id: "2",
			pick: { selector: "main > h1", tag: "h1", text: "", rect },
			note: "Shorter headline,\nmax six words",
		},
		{
			id: "3",
			pick: { selector: "footer", tag: "footer", text: "x", rect },
			note: "   ",
		},
	];

	it("is one message: canvas and revision, then each note on its element", () => {
		expect(
			canvasFeedbackMessage({
				title: "Pricing page — 3 options",
				revision: 2,
				notes,
			}),
		).toBe(
			[
				'Canvas feedback on "Pricing page — 3 options" (revision 2), 2 notes:',
				"",
				"1. Make it green",
				'   on <button> "Choose Pro" · `#plan-pro > button`',
				"2. Shorter headline,",
				"   max six words",
				"   on <h1> · `main > h1`",
				"",
				'Revise it as the next revision of the same canvas (title "Pricing page — 3 options").',
			].join("\n"),
		);
	});

	it("labels elements the way a person names them", () => {
		expect(canvasElementLabel({ tag: "button", text: "Choose Pro" })).toBe(
			'Button "Choose Pro"',
		);
		expect(canvasElementLabel({ tag: "my-card", text: "" })).toBe("<my-card>");
		expect(canvasElementLabel({ tag: "p", text: "x".repeat(80) })).toMatch(
			/^Paragraph "x{47}…"$/,
		);
	});
});

/**
 * A stand-in for the canvas's window, enough to run the bridge: its
 * listeners, its parent's received messages, and one button.
 */
function bridgeWindow(attributes: Record<string, string>) {
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const posted: unknown[] = [];
	// Posted messages arrive structured-cloned into the app's realm.
	const parent = {
		postMessage: (message: unknown) => posted.push(structuredClone(message)),
	};
	const element = () => ({
		style: {} as Record<string, string>,
		appendChild: () => undefined,
		removeChild: () => undefined,
		parentNode: null,
		setAttribute: () => undefined,
		textContent: "",
	});
	const html = {
		...element(),
		nodeType: 1,
		scrollWidth: 1280,
		scrollHeight: 800,
	};
	const body = {
		...element(),
		nodeType: 1,
		localName: "body",
		scrollWidth: 1280,
		scrollHeight: 640,
		parentElement: html,
	};
	const button = {
		nodeType: 1,
		localName: "button",
		id: "",
		parentElement: body,
		previousElementSibling: null,
		nextElementSibling: null,
		innerText: "Choose  Pro",
		getAttribute: (name: string) => attributes[name] ?? null,
		getBoundingClientRect: () => ({
			left: 10.4,
			top: 20,
			width: 120,
			height: 36,
		}),
		closest: (selector: string) =>
			selector === "[data-ytimesy-prompt]" && attributes["data-ytimesy-prompt"]
				? button
				: null,
	};
	const window = {
		parent,
		addEventListener: (type: string, listener: (event: unknown) => void) =>
			listeners.set(type, [...(listeners.get(type) ?? []), listener]),
	};
	const document = {
		documentElement: html,
		body,
		head: html,
		addEventListener: () => undefined,
		createElement: element,
		querySelectorAll: () => [],
		querySelector: () => button,
	};
	runInNewContext(
		CANVAS_BRIDGE_SCRIPT.replace(/^<script>/, "").replace(/<\/script>$/, ""),
		{
			window,
			document,
			requestAnimationFrame: (run: () => void) => run(),
			setTimeout: () => 0,
		},
	);
	// The startup size report is the viewer's, not these tests'.
	posted.length = 0;
	const fire = (type: string, event: object) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	const click = () => {
		const event = {
			target: button,
			defaultPrevented: false,
			preventDefault() {
				this.defaultPrevented = true;
			},
			stopPropagation: () => undefined,
			stopImmediatePropagation: () => undefined,
		};
		fire("click", event);
		return event;
	};
	return { parent, posted, fire, click };
}

describe("CANVAS_BRIDGE_SCRIPT", () => {
	it("is one inline script that cannot end early or reach the network", () => {
		const body = CANVAS_BRIDGE_SCRIPT.slice(
			"<script>".length,
			-"</script>".length,
		);
		expect(body).not.toMatch(/<\/script/i);
		expect(body).not.toMatch(
			/fetch|XMLHttpRequest|WebSocket|eval|location|open\(|cookie|localStorage/,
		);
	});

	it("reports a prompt button's text, and lets the click through", () => {
		const canvas = bridgeWindow({ "data-ytimesy-prompt": "Go with option B" });
		const event = canvas.click();
		expect(canvas.posted).toEqual([
			{ type: "ytimesy-canvas:prompt", text: "Go with option B" },
		]);
		expect(event.defaultPrevented).toBe(false);
		expect(canvasFrameMessage(canvas.posted[0])).toEqual({
			type: "prompt",
			text: "Go with option B",
		});
	});

	it("annotates only when its parent asks, and then reports the element instead of clicking it", () => {
		const canvas = bridgeWindow({ "data-ytimesy-prompt": "Go with option B" });
		// Another window (a nested frame, the canvas itself) cannot turn it on.
		canvas.fire("message", { source: {}, data: annotateMessage(true) });
		canvas.click();
		expect(canvas.posted).toHaveLength(1);
		canvas.posted.length = 0;
		canvas.fire("message", {
			source: canvas.parent,
			data: annotateMessage(true),
		});
		const event = canvas.click();
		expect(event.defaultPrevented).toBe(true);
		expect(canvas.posted).toHaveLength(1);
		expect(canvasFrameMessage(canvas.posted[0])).toEqual({
			type: "pick",
			pick: {
				selector: "body > button",
				tag: "button",
				text: "Choose Pro",
				rect: { x: 10, y: 20, width: 120, height: 36 },
			},
		});
	});

	it("reports where tracked elements are", () => {
		const canvas = bridgeWindow({});
		canvas.fire("message", {
			source: canvas.parent,
			data: trackMessage(["body > button"]),
		});
		expect(canvasFrameMessage(canvas.posted.at(-1))).toEqual({
			type: "rects",
			rects: [{ x: 10, y: 20, width: 120, height: 36 }],
		});
	});
});

describe("CANVAS_BRIDGE_SCRIPT viewer reports", () => {
	it("forwards a pinch as a wheel message and keeps the page from zooming", () => {
		const canvas = bridgeWindow({});
		let prevented = false;
		canvas.fire("wheel", {
			clientX: 30,
			clientY: 40,
			deltaX: 0,
			deltaY: -5,
			deltaMode: 0,
			ctrlKey: true,
			metaKey: false,
			preventDefault: () => {
				prevented = true;
			},
		});
		expect(prevented).toBe(true);
		expect(canvasFrameMessage(canvas.posted.at(-1))).toEqual({
			type: "wheel",
			x: 30,
			y: 40,
			dx: 0,
			dy: -5,
			mode: 0,
			zoom: true,
		});
	});

	it("forwards Cmd/Ctrl zoom keys", () => {
		const canvas = bridgeWindow({});
		canvas.fire("keydown", {
			key: "=",
			ctrlKey: false,
			metaKey: true,
			target: null,
			preventDefault: () => undefined,
		});
		expect(canvasFrameMessage(canvas.posted.at(-1))).toEqual({
			type: "zoomkey",
			key: "in",
		});
	});

	it("reports the document's size on load", () => {
		const canvas = bridgeWindow({});
		canvas.fire("load", {});
		const size = canvas.posted
			.map(canvasFrameMessage)
			.find((message) => message?.type === "size");
		expect(size).toEqual({
			type: "size",
			bounds: null,
			width: 1280,
			height: 800,
		});
	});
});

describe("canvasFeedbackMessage in Y²'s chat", () => {
	const note: CanvasNote = {
		id: "1",
		pick: { selector: "#hero", tag: "h1", text: "Art", rect },
		note: "Bigger",
	};

	it("marks the owner thread on the header and round-trips it", () => {
		const message = canvasFeedbackMessage({
			title: "Thread art",
			revision: 2,
			notes: [note],
			ownerThreadId: "7f3c-thread",
		});
		expect(message.split("\n")[0]).toBe(
			'Canvas feedback on "Thread art" (revision 2) [thread:7f3c-thread], 1 note:',
		);
		expect(message).toContain("`#hero`");
		expect(canvasFeedbackOwner(message)).toBe("7f3c-thread");
	});

	it("is unchanged without an owner, and has no owner to read", () => {
		const message = canvasFeedbackMessage({
			title: "Thread art",
			revision: 2,
			notes: [note],
		});
		expect(message).not.toContain("[thread:");
		expect(canvasFeedbackOwner(message)).toBeNull();
		expect(
			canvasFeedbackOwner(
				'Canvas feedback on "a [thread:x]" (revision 1), 1 note:',
			),
		).toBeNull();
	});
});
