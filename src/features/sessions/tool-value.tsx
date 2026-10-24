import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/**
 * Tool arguments and JSON results as labelled fields: key, then value.
 * Strings wrap, links open in a new tab, nested objects indent, long
 * lists fold; only very deep values fall back to pretty-printed JSON.
 */

const MAX_DEPTH = 4;
/** Lists longer than this, below the top level, start folded. */
const FOLD_ITEMS = 6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const fieldLabel = (key: string) => key.replaceAll("_", " ");

const webLink = (text: string) =>
	/^https?:\/\/\S+$/i.test(text) && text.length < 2048;

const isScalar = (value: unknown) =>
	value === null || typeof value !== "object";

function Scalar({ value }: { value: unknown }) {
	if (typeof value === "string") {
		if (value === "") return <span className="tool-value-empty">empty</span>;
		if (webLink(value))
			return (
				<a
					className="tool-value-link"
					href={value}
					target="_blank"
					rel="noopener noreferrer"
				>
					{value}
				</a>
			);
		return (
			<span
				className="tool-value-text"
				data-long={
					value.includes("\n") || value.length > 120 ? "true" : undefined
				}
			>
				{value}
			</span>
		);
	}
	return (
		<code
			className="tool-value-code"
			data-type={value === null ? "null" : typeof value}
		>
			{value === undefined ? "undefined" : String(value)}
		</code>
	);
}

export function ToolValue({
	value,
	depth = 0,
}: {
	value: unknown;
	depth?: number;
}) {
	if (isScalar(value)) return <Scalar value={value} />;
	if (depth >= MAX_DEPTH)
		return (
			<pre className="tool-value-json">{JSON.stringify(value, null, 2)}</pre>
		);
	if (Array.isArray(value)) {
		if (value.length === 0)
			return <span className="tool-value-empty">none</span>;
		if (
			value.every((entry) => isScalar(entry) && String(entry).length < 60) &&
			value.length <= 12
		)
			return (
				<span className="tool-value-chips">
					{value.map((entry, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: positional list items
						<Scalar key={index} value={entry} />
					))}
				</span>
			);
		const list = (
			<ol className="tool-value-list">
				{value.map((entry, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional list items
					<li key={index}>
						<ToolValue value={entry} depth={depth + 1} />
					</li>
				))}
			</ol>
		);
		return depth > 0 && value.length > FOLD_ITEMS ? (
			<Folded label={`${value.length} items`}>{list}</Folded>
		) : (
			list
		);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0)
		return <span className="tool-value-empty">empty</span>;
	return <ToolFieldList entries={entries} depth={depth} />;
}

function ToolFieldList({
	entries,
	depth,
}: {
	entries: [string, unknown][];
	depth: number;
}) {
	return (
		<dl className="session-tool-fields" data-depth={depth || undefined}>
			{entries.map(([key, entry]) => (
				<div
					key={key}
					data-block={
						isScalar(entry) &&
						!(typeof entry === "string" && entry.length > 120)
							? undefined
							: "true"
					}
				>
					<dt>{fieldLabel(key)}</dt>
					<dd>
						<ToolValue value={entry} depth={depth + 1} />
					</dd>
				</div>
			))}
		</dl>
	);
}

function Folded({ label, children }: { label: string; children: ReactNode }) {
	return (
		<details className="tool-value-fold">
			<summary>
				<ChevronRight size={12} strokeWidth={1.5} aria-hidden="true" />
				{label}
			</summary>
			{children}
		</details>
	);
}

/** A JSON object's fields, an empty-arguments line, or free-form text as-is. */
export function ToolFields({ input }: { input: string }) {
	let value: unknown;
	try {
		value = JSON.parse(input);
	} catch {
		return <pre className="tool-value-json">{input}</pre>;
	}
	if (isRecord(value) && Object.keys(value).length === 0)
		return <p className="tool-panel-meta">No arguments</p>;
	if (!value || typeof value !== "object")
		return <pre className="tool-value-json">{input}</pre>;
	return <ToolValue value={value} />;
}

/** About how tall a value renders, to decide whether it starts clamped. */
export function looksLong(text: string) {
	return text.length > 1600 || text.split("\n").length > 24;
}

/** Long content shows its top with a "Show more" to open the rest. */
export function ShowMore({
	long,
	children,
}: {
	long: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (!long) return <>{children}</>;
	return (
		<>
			<div className="tool-clamp" data-open={open ? "true" : undefined}>
				{children}
			</div>
			<button
				type="button"
				className="tool-show-more"
				onClick={() => setOpen((value) => !value)}
			>
				{open ? "Show less" : "Show more"}
			</button>
		</>
	);
}
