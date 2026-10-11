import type { ReactNode } from "react";

export function StatusBadge({
	tone,
	children,
}: {
	tone: "success" | "warning" | "muted";
	children: ReactNode;
}) {
	return (
		<span className={`integration-badge integration-badge-${tone}`}>
			{children}
		</span>
	);
}

/** An on/off switch for enabling a plugin or server. */
export function IntegrationSwitch({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			className="integration-switch"
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span />
		</button>
	);
}
