/**
 * Design review on a canvas: the user pins notes on elements of a canvas and
 * sends them to the agent as one message, and a canvas's own buttons
 * (data-ytimesy-prompt) put a reply in the message box.
 *
 * The canvas runs in an opaque-origin sandbox (canvas.ts), so the app sees
 * into it only through messages from CANVAS_BRIDGE_SCRIPT, which the app
 * puts at the top of every canvas document. The canvas's own scripts share
 * that document and can post the same messages, so every message is read
 * as untrusted input (canvasFrameMessage): only these exact shapes and
 * lengths pass, text is cleaned, and nothing in one is ever run, opened or
 * sent without the user.
 */

/** The prefix of every message between the app and a canvas. */
const CHANNEL = "ytimesy-canvas:";

export const CANVAS_PROMPT_LIMIT = 500;
export const CANVAS_PICK_TEXT_LIMIT = 120;
export const CANVAS_SELECTOR_LIMIT = 300;
export const CANVAS_NOTE_LIMIT = 2_000;
/** The most pins one canvas revision takes (and positions one message carries). */
export const CANVAS_NOTES_LIMIT = 30;
/** Coordinates beyond this are not a real element's. */
const COORDINATE_LIMIT = 1_000_000;

/** Where an element is in the canvas's viewport, in CSS pixels. */
export type CanvasRect = {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
};

/** The element the user clicked while annotating. */
export type CanvasElementPick = {
	/** A CSS selector that finds the element again in the canvas. */
	readonly selector: string;
	/** Its tag name, lower case. */
	readonly tag: string;
	/** Its visible text or label, at most CANVAS_PICK_TEXT_LIMIT characters. */
	readonly text: string;
	readonly rect: CanvasRect;
};

/** A message from a canvas the app acts on. */
export type CanvasFrameMessage =
	| { readonly type: "pick"; readonly pick: CanvasElementPick }
	| { readonly type: "prompt"; readonly text: string }
	/** Where the tracked elements are now, in the order the app asked for. */
	| { readonly type: "rects"; readonly rects: readonly (CanvasRect | null)[] }
	/** Escape pressed inside the canvas: stop annotating. */
	| { readonly type: "escape" };

/** A message from the app to a canvas. */
export type CanvasHostMessage =
	| { readonly type: `${typeof CHANNEL}annotate`; readonly on: boolean }
	| {
			readonly type: `${typeof CHANNEL}track`;
			readonly selectors: readonly string[];
	  };

export function annotateMessage(on: boolean): CanvasHostMessage {
	return { type: `${CHANNEL}annotate`, on };
}

export function trackMessage(selectors: readonly string[]): CanvasHostMessage {
	return {
		type: `${CHANNEL}track`,
		selectors: selectors.slice(0, CANVAS_NOTES_LIMIT),
	};
}

/** C0/C1 controls (keeping newline and tab) and bidirectional overrides. */
const UNSAFE_CHARACTERS =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
	/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Text from a canvas, safe to show and to put in a message. */
export function cleanCanvasText(text: string): string {
	return text
		.replace(UNSAFE_CHARACTERS, "")
		.replace(/\t/g, " ")
		.replace(/\r\n?/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** One line of text (an element's label or a selector). */
function cleanLine(text: string): string {
	return cleanCanvasText(text).replace(/\s+/g, " ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** The record has exactly these keys: no more, no fewer. */
function hasExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => key in value);
}

function boundedString(value: unknown, limit: number): value is string {
	return typeof value === "string" && value.length <= limit;
}

function coordinate(value: unknown, min: number): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= min &&
		value <= COORDINATE_LIMIT
	);
}

function canvasRect(value: unknown): CanvasRect | null {
	if (
		!isPlainRecord(value) ||
		!hasExactKeys(value, ["x", "y", "width", "height"])
	)
		return null;
	const { x, y, width, height } = value;
	if (
		!coordinate(x, -COORDINATE_LIMIT) ||
		!coordinate(y, -COORDINATE_LIMIT) ||
		!coordinate(width, 0) ||
		!coordinate(height, 0)
	)
		return null;
	return { x, y, width, height };
}

const TAG = /^[a-z][a-z0-9-]{0,63}$/i;

function elementPick(value: Record<string, unknown>): CanvasElementPick | null {
	if (!hasExactKeys(value, ["type", "selector", "tag", "text", "rect"]))
		return null;
	const { selector, tag, text } = value;
	if (
		!boundedString(selector, CANVAS_SELECTOR_LIMIT) ||
		!boundedString(tag, 64) ||
		!TAG.test(tag) ||
		!boundedString(text, CANVAS_PICK_TEXT_LIMIT)
	)
		return null;
	const rect = canvasRect(value.rect);
	const cleanSelector = cleanLine(selector);
	if (!rect || !cleanSelector) return null;
	return {
		selector: cleanSelector,
		tag: tag.toLowerCase(),
		text: cleanLine(text),
		rect,
	};
}

/**
 * The message a canvas posted, or null for anything that is not exactly one
 * of the bridge's messages. The caller checks first that it came from that
 * canvas's frame (canvasMessageFromFrame).
 */
export function canvasFrameMessage(data: unknown): CanvasFrameMessage | null {
	if (!isPlainRecord(data) || typeof data.type !== "string") return null;
	switch (data.type) {
		case `${CHANNEL}pick`: {
			const pick = elementPick(data);
			return pick ? { type: "pick", pick } : null;
		}
		case `${CHANNEL}prompt`: {
			if (
				!hasExactKeys(data, ["type", "text"]) ||
				!boundedString(data.text, CANVAS_PROMPT_LIMIT)
			)
				return null;
			const text = cleanCanvasText(data.text);
			return text ? { type: "prompt", text } : null;
		}
		case `${CHANNEL}rects`: {
			if (
				!hasExactKeys(data, ["type", "rects"]) ||
				!Array.isArray(data.rects) ||
				data.rects.length > CANVAS_NOTES_LIMIT
			)
				return null;
			const rects: (CanvasRect | null)[] = [];
			for (const entry of data.rects) {
				if (entry === null) {
					rects.push(null);
					continue;
				}
				const rect = canvasRect(entry);
				if (!rect) return null;
				rects.push(rect);
			}
			return { type: "rects", rects };
		}
		case `${CHANNEL}escape`:
			return hasExactKeys(data, ["type"]) ? { type: "escape" } : null;
		default:
			return null;
	}
}

/** Messages that only a person's click in the canvas may cause. */
function needsUserActivation(message: CanvasFrameMessage): boolean {
	return message.type === "pick" || message.type === "prompt";
}

/**
 * A message event's canvas message, only when it came from this canvas's
 * own frame (not another frame, tab, extension or the app itself), is one
 * of the bridge's exact shapes, and, for a pin or a prompt, follows a real
 * click (the page has user activation, which a click inside the frame
 * gives its ancestors), so a canvas cannot fill the message box by itself.
 */
export function canvasMessageFromFrame(
	event: { readonly source: unknown; readonly data: unknown },
	frameWindow: unknown,
	userActive: boolean,
): CanvasFrameMessage | null {
	if (frameWindow === null || frameWindow === undefined) return null;
	if (event.source !== frameWindow) return null;
	const message = canvasFrameMessage(event.data);
	if (!message) return null;
	if (needsUserActivation(message) && !userActive) return null;
	return message;
}

const ELEMENT_NAMES: Readonly<Record<string, string>> = {
	a: "Link",
	button: "Button",
	img: "Image",
	svg: "Graphic",
	input: "Input",
	textarea: "Text field",
	select: "Select",
	label: "Label",
	h1: "Heading",
	h2: "Heading",
	h3: "Heading",
	h4: "Heading",
	h5: "Heading",
	h6: "Heading",
	p: "Paragraph",
	li: "List item",
	ul: "List",
	ol: "List",
	nav: "Navigation",
	header: "Header",
	footer: "Footer",
	section: "Section",
	article: "Card",
	aside: "Sidebar",
	table: "Table",
	tr: "Table row",
	td: "Table cell",
	th: "Table header",
	form: "Form",
	span: "Text",
	strong: "Text",
	em: "Text",
	small: "Text",
	div: "Box",
	main: "Main area",
};

/** How a picked element reads to a person: `Button "Choose Pro"`. */
export function canvasElementLabel(
	pick: Pick<CanvasElementPick, "tag" | "text">,
): string {
	const name = ELEMENT_NAMES[pick.tag] ?? `<${pick.tag}>`;
	if (!pick.text) return name;
	const text =
		pick.text.length > 48 ? `${pick.text.slice(0, 47).trimEnd()}…` : pick.text;
	return `${name} "${text}"`;
}

/** How a canvas's owner thread is named in a feedback message. */
export const canvasOwnerMarker = (threadId: string) => `[thread:${threadId}]`;

/** The owner thread a feedback message names, if it has the marker. */
export function canvasFeedbackOwner(message: string): string | null {
	const header = message.split("\n", 1)[0] ?? "";
	return (
		/^Canvas feedback on .*\(revision \d+\) \[thread:([^\]\s]+)\]/.exec(
			header,
		)?.[1] ?? null
	);
}

/** One pinned note on a canvas revision. */
export type CanvasNote = {
	readonly id: string;
	readonly pick: CanvasElementPick;
	readonly note: string;
};

/**
 * The one message a set of notes becomes in the message box: which canvas
 * and revision, then each note with the element it is on (its kind, text
 * and selector, so the agent can find it in its HTML).
 */
export function canvasFeedbackMessage(input: {
	readonly title: string;
	readonly revision: number;
	readonly notes: readonly CanvasNote[];
	/** A canvas shown in Y²'s chat: the thread that owns it (marked `[thread:<id>]`). */
	readonly ownerThreadId?: string;
}): string {
	const notes = input.notes.filter((entry) => cleanCanvasText(entry.note));
	const count = notes.length === 1 ? "1 note" : `${notes.length} notes`;
	const lines = notes.map((entry, index) => {
		const { tag, text, selector } = entry.pick;
		const element = `<${tag}>${text ? ` "${text}"` : ""} · \`${selector}\``;
		const note = cleanCanvasText(entry.note).split("\n").join("\n   ");
		return `${index + 1}. ${note}\n   on ${element}`;
	});
	return [
		`Canvas feedback on "${input.title}" (revision ${input.revision})${input.ownerThreadId ? ` ${canvasOwnerMarker(input.ownerThreadId)}` : ""}, ${count}:`,
		"",
		...lines,
		"",
		`Revise it as the next revision of the same canvas (title "${input.title}").`,
	].join("\n");
}

/**
 * Runs inside every canvas document (put right after its policy by
 * canvasDocument). It does nothing visible until the app asks:
 * - annotate on: hovering outlines an element, a click (which the canvas
 *   then does not see) reports that element instead; Escape reports.
 * - track: reports where the given selectors' elements are, again on
 *   scroll and resize, so the app's pins follow the content.
 * - always: a click on an element with data-ytimesy-prompt reports its text.
 * It accepts messages only from its parent, posts only to its parent, and
 * sends nothing but these messages; inline scripts are allowed by the
 * policy, so it runs under the same CSP as the canvas.
 */
export const CANVAS_BRIDGE_SCRIPT = `<script>(function(){var P="${CHANNEL}",up=window.parent;if(!up||up===window)return;var on=false,box=null,cur=null,tracked=[],queued=false;function post(m){try{up.postMessage(m,"*")}catch(e){}}function element(t){if(!t||t.nodeType!==1)t=t&&t.parentElement;if(!t||t===document.documentElement||t===document.body||t===box)return null;return t}function esc(v){return window.CSS&&CSS.escape?CSS.escape(v):v.replace(/[^a-zA-Z0-9_-]/g,"\\\\$&")}function uniqueId(n){if(!n.id)return null;var s="#"+esc(n.id);try{return document.querySelectorAll(s).length===1?s:null}catch(e){return null}}function selector(el){var own=uniqueId(el);if(own)return own;var parts=[],n=el;while(n&&n.nodeType===1&&n!==document.documentElement&&parts.length<12){var id=uniqueId(n);if(id){parts.unshift(id);break}var tag=n.localName,i=1,more=false,s=n;while((s=s.previousElementSibling))if(s.localName===tag)i++;s=n;while((s=s.nextElementSibling))if(s.localName===tag){more=true;break}parts.unshift(i===1&&!more?tag:tag+":nth-of-type("+i+")");if(n===document.body)break;n=n.parentElement}while(parts.join(" > ").length>${CANVAS_SELECTOR_LIMIT}&&parts.length>1)parts.shift();return parts.join(" > ").slice(0,${CANVAS_SELECTOR_LIMIT})}function label(el){var t=el.getAttribute("aria-label")||el.getAttribute("alt")||el.getAttribute("title")||el.innerText||el.textContent||el.getAttribute("placeholder")||el.value||"";return String(t).replace(/\\s+/g," ").trim().slice(0,${CANVAS_PICK_TEXT_LIMIT})}function rect(el){var r=el.getBoundingClientRect();return{x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}}function outline(el){if(!box){box=document.createElement("div");var s=box.style;s.position="fixed";s.pointerEvents="none";s.zIndex="2147483647";s.boxSizing="border-box";s.border="2px solid #3b82f6";s.borderRadius="4px";s.background="rgba(59,130,246,.10)";s.transition="all 60ms ease-out";(document.body||document.documentElement).appendChild(box)}if(!el){box.style.display="none";return}var r=el.getBoundingClientRect();box.style.display="block";box.style.left=(r.left-2)+"px";box.style.top=(r.top-2)+"px";box.style.width=(r.width+4)+"px";box.style.height=(r.height+4)+"px"}function report(){queued=false;if(!tracked.length)return;var out=[];for(var i=0;i<tracked.length;i++){var el=null;try{el=document.querySelector(tracked[i])}catch(e){}out.push(el?rect(el):null)}post({type:P+"rects",rects:out})}function soon(){if(!queued){queued=true;requestAnimationFrame(report)}}function block(e){if(on){e.preventDefault();e.stopPropagation();e.stopImmediatePropagation()}}["pointerdown","mousedown","pointerup","mouseup","dblclick","auxclick","contextmenu","submit"].forEach(function(t){window.addEventListener(t,block,true)});window.addEventListener("pointermove",function(e){if(on)outline(element(e.target))},true);document.addEventListener("mouseleave",function(){if(on)outline(null)});window.addEventListener("click",function(e){if(on){block(e);var el=element(e.target);if(el)post({type:P+"pick",selector:selector(el),tag:String(el.localName).slice(0,64),text:label(el),rect:rect(el)});return}var t=e.target&&e.target.closest?e.target.closest("[data-ytimesy-prompt]"):null;if(t)post({type:P+"prompt",text:String(t.getAttribute("data-ytimesy-prompt")||"").slice(0,${CANVAS_PROMPT_LIMIT})})},true);window.addEventListener("keydown",function(e){if(on&&e.key==="Escape"){block(e);post({type:P+"escape"})}},true);window.addEventListener("scroll",soon,true);window.addEventListener("resize",soon);window.addEventListener("load",soon);window.addEventListener("message",function(e){if(e.source!==up)return;var m=e.data;if(!m||typeof m!=="object")return;if(m.type===P+"annotate"){on=m.on===true;if(!cur){cur=document.createElement("style");cur.textContent="*{cursor:crosshair!important}";}if(on)(document.head||document.documentElement).appendChild(cur);else if(cur.parentNode)cur.parentNode.removeChild(cur);if(!on)outline(null)}else if(m.type===P+"track"&&Array.isArray(m.selectors)){tracked=m.selectors.filter(function(s){return typeof s==="string"}).slice(0,${CANVAS_NOTES_LIMIT});soon()}})})()</script>`;
