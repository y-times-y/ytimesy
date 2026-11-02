import { cn } from "cn";
import { Check, ChevronDown } from "lucide-react";
import "./menu-select.css";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";

export type MenuSelectOption = {
	readonly value: string;
	readonly label: ReactNode;
	/** Plain text for typeahead when `label` is not a string. */
	readonly textValue?: string;
	readonly title?: string;
	readonly disabled?: boolean;
};

/**
 * The option a key moves to in an open menu: arrows step and wrap,
 * Home/End jump. Null for any other key.
 */
export function menuSelectKeyTarget(
	key: string,
	current: number,
	count: number,
): number | null {
	if (count === 0) return null;
	if (key === "ArrowDown") return current < 0 ? 0 : (current + 1) % count;
	if (key === "ArrowUp")
		return current < 0 ? count - 1 : (current - 1 + count) % count;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	return null;
}

/** The next option after `current` whose text starts with the typed letters. */
export function menuSelectTypeahead(
	texts: readonly string[],
	typed: string,
	current: number,
): number | null {
	const prefix = typed.toLowerCase();
	if (!prefix) return null;
	for (let step = 1; step <= texts.length; step++) {
		const index = (current + step + texts.length) % texts.length;
		if (texts[index]?.toLowerCase().startsWith(prefix)) return index;
	}
	return null;
}

function optionText(option: MenuSelectOption) {
	return (
		option.textValue ??
		(typeof option.label === "string" ? option.label : option.value)
	);
}

/**
 * A single-choice picker drawn as the app's own popover menu (the composer
 * pickers' surface and rows), never a native or OS-looking select.
 */
export function MenuSelect({
	value,
	onValueChange,
	options,
	placeholder,
	valueLabel,
	id,
	name,
	disabled = false,
	className,
	menuClassName,
	side = "bottom",
	align = "start",
	onBlur,
	"aria-label": ariaLabel,
	"aria-invalid": ariaInvalid,
}: {
	value: string;
	onValueChange: (value: string) => void;
	options: readonly MenuSelectOption[];
	placeholder?: string;
	/** Shown in the trigger instead of the chosen option's label. */
	valueLabel?: ReactNode;
	id?: string;
	/** Submits the value with a form, through a hidden input. */
	name?: string;
	disabled?: boolean;
	className?: string;
	menuClassName?: string;
	side?: "top" | "right" | "bottom" | "left";
	align?: "start" | "center" | "end";
	onBlur?: () => void;
	"aria-label"?: string;
	"aria-invalid"?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const listRef = useRef<HTMLDivElement>(null);
	const typed = useRef({ text: "", at: 0 });
	const selected = options.find((option) => option.value === value);
	const shown = valueLabel ?? selected?.label;

	function enabledOptions() {
		return Array.from(
			listRef.current?.querySelectorAll<HTMLButtonElement>(
				'[role="option"]:not(:disabled)',
			) ?? [],
		);
	}

	function focusOption(target: HTMLButtonElement | undefined) {
		target?.focus();
		target?.scrollIntoView?.({ block: "nearest" });
	}

	function choose(next: string) {
		setOpen(false);
		if (next !== value) onValueChange(next);
	}

	function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Tab") {
			event.preventDefault();
			setOpen(false);
			return;
		}
		const items = enabledOptions();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		const target = menuSelectKeyTarget(event.key, current, items.length);
		if (target !== null) {
			event.preventDefault();
			focusOption(items[target]);
			return;
		}
		if (
			event.key.length === 1 &&
			event.key !== " " &&
			!event.metaKey &&
			!event.ctrlKey &&
			!event.altKey
		) {
			const now = Date.now();
			const text =
				now - typed.current.at < 700
					? typed.current.text + event.key
					: event.key;
			typed.current = { text, at: now };
			const texts = items.map((item) => item.dataset.text ?? "");
			// A fresh letter moves past the current row; a longer prefix may stay.
			const from = text.length > 1 ? current - 1 : current;
			const match = menuSelectTypeahead(texts, text, from);
			if (match !== null) focusOption(items[match]);
		}
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				id={id}
				data-slot="menu-select-trigger"
				className={cn("menu-select-trigger", className)}
				disabled={disabled}
				aria-label={ariaLabel}
				aria-invalid={ariaInvalid || undefined}
				aria-haspopup="listbox"
				title={typeof shown === "string" ? shown : undefined}
				onBlur={onBlur}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				<span
					className="menu-select-value"
					data-placeholder={shown ? undefined : ""}
				>
					{shown ?? placeholder}
				</span>
				<ChevronDown className="size-3" aria-hidden="true" />
			</PopoverTrigger>
			{name ? <input type="hidden" name={name} value={value} /> : null}
			<PopoverContent
				side={side}
				align={align}
				collisionPadding={12}
				role="listbox"
				aria-label={ariaLabel}
				className={cn("project-picker menu-select-menu", menuClassName)}
				onKeyDown={onListKeyDown}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					const items = enabledOptions();
					focusOption(
						items.find((item) => item.dataset.value === value) ?? items[0],
					);
				}}
			>
				<div ref={listRef} className="project-picker-list" role="presentation">
					{options.map((option) => {
						const isSelected = option.value === value;
						return (
							<button
								key={option.value}
								type="button"
								role="option"
								tabIndex={-1}
								aria-selected={isSelected}
								className="project-picker-choice menu-select-choice"
								data-selected={isSelected ? "true" : undefined}
								data-value={option.value}
								data-text={optionText(option)}
								disabled={option.disabled}
								title={option.title}
								onClick={() => choose(option.value)}
							>
								<span className="menu-row-label">{option.label}</span>
								{isSelected ? <Check size={14} aria-hidden="true" /> : null}
							</button>
						);
					})}
				</div>
			</PopoverContent>
		</Popover>
	);
}
