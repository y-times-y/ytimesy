import { useEffect, useState } from "react";
import {
	COMPOSER_DELIVERY_STORAGE_KEY,
	type ComposerDelivery,
	DEFAULT_COMPOSER_DELIVERY,
	parseComposerDelivery,
} from "#/domain/composer-delivery";

/**
 * The remembered delivery choice (per browser profile, so per person on this
 * device). The server render and first client render use the default; the
 * stored choice applies right after hydration.
 */
export function useComposerDelivery() {
	const [delivery, setDelivery] = useState<ComposerDelivery>(
		DEFAULT_COMPOSER_DELIVERY,
	);
	useEffect(() => {
		try {
			setDelivery(
				parseComposerDelivery(
					window.localStorage.getItem(COMPOSER_DELIVERY_STORAGE_KEY),
				),
			);
		} catch {
			/* Storage unavailable: the choice lasts for this page only. */
		}
	}, []);
	const choose = (next: ComposerDelivery) => {
		setDelivery(next);
		try {
			window.localStorage.setItem(COMPOSER_DELIVERY_STORAGE_KEY, next);
		} catch {
			/* Kept in memory. */
		}
	};
	return [delivery, choose] as const;
}

const OPTIONS: readonly {
	readonly id: ComposerDelivery;
	readonly label: string;
	readonly hint: string;
}[] = [
	{
		id: "queue",
		label: "Queue",
		hint: "Send after this turn ends (Enter)",
	},
	{
		id: "steer",
		label: "Steer",
		hint: "The running turn reads it at its next step, no extra turn (Ctrl/Cmd+Enter)",
	},
];

/**
 * Queue | Steer, native radios styled as a segmented control (arrow keys and
 * Tab behave as for any radio group). It keeps its space (hidden, not
 * removed) while no turn runs, so the row does not jump when a turn starts
 * or ends.
 */
export function ComposerDeliveryToggle({
	value,
	onChange,
	active,
}: {
	readonly value: ComposerDelivery;
	readonly onChange: (next: ComposerDelivery) => void;
	/** A turn is running: the choice applies to the next send. */
	readonly active: boolean;
}) {
	return (
		<fieldset
			className="composer-delivery"
			data-active={active ? "true" : "false"}
			aria-hidden={active ? undefined : true}
			// Not focusable or clickable while hidden.
			inert={!active}
		>
			<legend className="composer-delivery-legend">
				How to send while the agent is working
			</legend>
			{OPTIONS.map((option) => (
				<label
					key={option.id}
					title={option.hint}
					data-checked={value === option.id ? "true" : undefined}
				>
					<input
						type="radio"
						name="composer-delivery"
						value={option.id}
						checked={value === option.id}
						onChange={() => onChange(option.id)}
					/>
					<span>{option.label}</span>
				</label>
			))}
		</fieldset>
	);
}
