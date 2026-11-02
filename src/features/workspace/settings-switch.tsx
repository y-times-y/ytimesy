import type { ComponentProps } from "react";
import { Switch } from "#/components/ui/switch";

/**
 * A Settings switch that never shows a value it does not know: until the
 * saved setting is read, an empty track stands in (same size, no thumb), so
 * nothing shows off and then flips on.
 */
export function SettingsSwitch({
	checked,
	...props
}: Omit<ComponentProps<typeof Switch>, "checked" | "defaultChecked"> & {
	readonly checked: boolean | undefined;
}) {
	if (checked === undefined)
		return (
			<span
				id={props.id}
				className="settings-switch-pending"
				role="img"
				aria-busy="true"
				aria-label="Loading"
			/>
		);
	return <Switch checked={checked} {...props} />;
}
