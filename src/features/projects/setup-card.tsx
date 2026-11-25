import { Check, CircleAlert, Info, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { SetupCardModel, SetupCardProgress } from "#/domain/setup-card";

export type SetupCardAction = {
	readonly label: string;
	readonly onClick: () => void;
	readonly title?: string;
	readonly disabled?: boolean;
};

const PROGRESS: readonly { key: SetupCardProgress; label: string }[] = [
	{ key: "queued", label: "Queued" },
	{ key: "building", label: "Building" },
	{ key: "ready", label: "Ready" },
];

function CardIcon({ model }: { model: SetupCardModel }) {
	if (model.state === "ready") return <Check size={15} aria-hidden="true" />;
	if (model.tone === "failure")
		return <CircleAlert size={15} aria-hidden="true" />;
	if (model.tone === "needs-you") return <Info size={15} aria-hidden="true" />;
	return (
		<LoaderCircle
			size={15}
			className="workspace-status-spin"
			aria-hidden="true"
		/>
	);
}

/**
 * The project's setup in one calm card: a title, one plain reason, the
 * progress (queued, building, ready), a primary action with quieter ones,
 * and the steps and output folded under Details. Only a real failure takes
 * the failure tone; the rest is neutral or the "needs you" blue.
 */
export function SetupCard({
	model,
	primary,
	secondary = [],
	details,
	meta,
	children,
}: {
	model: SetupCardModel;
	primary?: SetupCardAction;
	secondary?: readonly SetupCardAction[];
	/** Steps and output; shown folded when the model has details. */
	details?: ReactNode;
	/** A quiet note on the title line, e.g. how long it has taken. */
	meta?: ReactNode;
	/** In place content, e.g. the Connect GitHub step. */
	children?: ReactNode;
}) {
	const current = PROGRESS.findIndex((item) => item.key === model.progress);
	const alert = model.tone !== "calm";
	return (
		<section
			className="setup-card"
			aria-label="Project setup"
			data-state={model.state}
			data-tone={model.tone}
			role={alert ? "alert" : "status"}
		>
			<header className="setup-card-head">
				<span className="setup-card-icon">
					<CardIcon model={model} />
				</span>
				<h3 className="setup-card-title">{model.title}</h3>
				{meta ? <span className="setup-card-meta">{meta}</span> : null}
			</header>
			<p className="setup-card-reason">{model.reason}</p>
			{model.progress ? (
				<ol className="setup-card-progress" aria-label="Setup progress">
					{PROGRESS.map((item, index) => (
						<li
							key={item.key}
							data-done={index < current || undefined}
							data-current={index === current || undefined}
							aria-current={index === current ? "step" : undefined}
						>
							{item.label}
						</li>
					))}
				</ol>
			) : null}
			{children}
			{primary || secondary.length ? (
				<div className="setup-card-actions">
					{primary ? (
						<button
							type="button"
							className="setup-card-primary"
							disabled={primary.disabled}
							title={primary.title}
							onClick={primary.onClick}
						>
							{primary.label}
						</button>
					) : null}
					{secondary.map((action) => (
						<button
							key={action.label}
							type="button"
							className="setup-card-secondary"
							disabled={action.disabled}
							title={action.title}
							onClick={action.onClick}
						>
							{action.label}
						</button>
					))}
				</div>
			) : null}
			{details && model.hasDetails ? (
				<details className="setup-card-details">
					<summary>Details and logs</summary>
					{details}
				</details>
			) : null}
		</section>
	);
}
