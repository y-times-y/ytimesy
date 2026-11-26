import { Dialog } from "radix-ui";
import { type FormEvent, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
	CAPTAIN_COLORS,
	CAPTAIN_LABEL_LIMIT,
	CAPTAIN_NAME_LIMIT,
	CAPTAIN_PRESETS,
	CAPTAIN_ROLE_LIMIT,
	type Captain,
	type CaptainInput,
} from "#/domain/captain";
import { CaptainAvatar } from "./captain-avatar";
import "./captains.css";

/**
 * The create and edit dialog: a name, a group label, a colour and the role
 * instructions the captain's turns start from. Saving never starts a turn.
 */
export function CaptainDialog({
	open,
	onOpenChange,
	captain,
	labels,
	atLimit,
	onSave,
	onDelete,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The captain being edited; absent when creating. */
	captain?: Captain;
	/** Labels already in use, offered as suggestions. */
	labels: readonly string[];
	atLimit: boolean;
	onSave: (input: CaptainInput) => Promise<string | null>;
	onDelete?: () => Promise<void>;
}) {
	const id = useId();
	const [name, setName] = useState(captain?.name ?? "");
	const [label, setLabel] = useState(captain?.label ?? "");
	const [color, setColor] = useState<string>(
		captain?.color ?? CAPTAIN_COLORS[0],
	);
	const [role, setRole] = useState(captain?.rolePrompt ?? "");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const creating = !captain;

	async function submit(event: FormEvent) {
		event.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		const problem = await onSave({
			name,
			label: label.trim() || null,
			color,
			rolePrompt: role,
		}).catch(() => "Something went wrong. Try again.");
		setBusy(false);
		if (problem) setError(problem);
		else onOpenChange(false);
	}

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="captain-dialog-overlay" />
				<Dialog.Content
					className="captain-dialog"
					aria-describedby={`${id}-help`}
				>
					<form onSubmit={submit}>
						<Dialog.Title className="captain-dialog-title">
							{creating ? "New captain" : "Edit captain"}
						</Dialog.Title>
						<Dialog.Description
							id={`${id}-help`}
							className="captain-dialog-help"
						>
							A captain is a Super agent with a role. It sleeps until you
							message it, @mention it or one of its threads needs it, shares
							this project's model connection and usage, and has no machine.
						</Dialog.Description>
						{creating && atLimit ? (
							<p className="captain-dialog-error" role="alert">
								A project holds up to 5 captains. Delete one to add another.
							</p>
						) : null}
						<div className="captain-dialog-row">
							<div className="captain-field">
								<Label htmlFor={`${id}-name`}>Name</Label>
								<Input
									id={`${id}-name`}
									value={name}
									maxLength={CAPTAIN_NAME_LIMIT}
									onChange={(event) => setName(event.target.value)}
									placeholder="seo"
									autoComplete="off"
									required
								/>
							</div>
							<div className="captain-field">
								<Label htmlFor={`${id}-label`}>Label (group)</Label>
								<Input
									id={`${id}-label`}
									value={label}
									maxLength={CAPTAIN_LABEL_LIMIT}
									onChange={(event) => setLabel(event.target.value)}
									placeholder="content"
									autoComplete="off"
								/>
								{labels.length ? (
									<div className="captain-presets">
										{labels.map((entry) => (
											<button
												key={entry}
												type="button"
												onClick={() => setLabel(entry)}
											>
												{entry}
											</button>
										))}
									</div>
								) : null}
							</div>
						</div>
						<fieldset className="captain-field captain-colors">
							<legend>Colour</legend>
							<div>
								{CAPTAIN_COLORS.map((entry) => (
									<button
										key={entry}
										type="button"
										aria-pressed={entry === color}
										aria-label={entry}
										className="captain-swatch"
										style={{ background: entry }}
										onClick={() => setColor(entry)}
									/>
								))}
								<span className="captain-preview">
									<CaptainAvatar name={name || "?"} color={color} size={28} />
								</span>
							</div>
						</fieldset>
						<div className="captain-field">
							<Label htmlFor={`${id}-role`}>Role</Label>
							<Textarea
								id={`${id}-role`}
								value={role}
								maxLength={CAPTAIN_ROLE_LIMIT}
								rows={5}
								onChange={(event) => setRole(event.target.value)}
								placeholder="What this captain looks after, and how it should report."
							/>
							{creating ? (
								<div className="captain-presets">
									<span>Start from</span>
									{CAPTAIN_PRESETS.map((preset) => (
										<button
											key={preset.name}
											type="button"
											onClick={() => {
												setName((current) => current || preset.name);
												setLabel((current) => current || preset.label);
												setRole(preset.role);
											}}
										>
											{preset.name}
										</button>
									))}
								</div>
							) : null}
							<p className="captain-dialog-note">
								The role cannot loosen the rules: a captain never merges,
								deploys, deletes or spends without you.
							</p>
						</div>
						{error ? (
							<p className="captain-dialog-error" role="alert">
								{error}
							</p>
						) : null}
						<div className="captain-dialog-actions">
							{onDelete ? (
								confirmDelete ? (
									<Button
										type="button"
										variant="destructive"
										onClick={() => void onDelete()}
									>
										Delete {captain?.name}? Its chat is archived.
									</Button>
								) : (
									<Button
										type="button"
										variant="ghost"
										onClick={() => setConfirmDelete(true)}
									>
										Delete
									</Button>
								)
							) : null}
							<span className="captain-dialog-spacer" />
							<Dialog.Close asChild>
								<Button type="button" variant="ghost">
									Cancel
								</Button>
							</Dialog.Close>
							<Button
								type="submit"
								disabled={busy || !name.trim() || (creating && atLimit)}
							>
								{creating ? "Create captain" : "Save"}
							</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/** Names the project's Super agent (the leader); empty goes back to "Super agent". */
export function LeaderNameDialog({
	open,
	onOpenChange,
	current,
	onSave,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	current: string;
	onSave: (name: string) => Promise<string | null>;
}) {
	const id = useId();
	const [name, setName] = useState(current);
	const [error, setError] = useState<string | null>(null);
	async function submit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const problem = await onSave(name.trim()).catch(() => "Could not rename.");
		if (problem) setError(problem);
		else onOpenChange(false);
	}
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="captain-dialog-overlay" />
				<Dialog.Content
					className="captain-dialog"
					aria-describedby={`${id}-help`}
				>
					<form onSubmit={submit}>
						<Dialog.Title className="captain-dialog-title">
							Rename the Super agent
						</Dialog.Title>
						<Dialog.Description
							id={`${id}-help`}
							className="captain-dialog-help"
						>
							The leader of this project's captains. Leave it empty to keep
							“Super agent”.
						</Dialog.Description>
						<div className="captain-field">
							<Label htmlFor={`${id}-name`}>Name</Label>
							<Input
								id={`${id}-name`}
								value={name}
								maxLength={CAPTAIN_NAME_LIMIT}
								onChange={(event) => setName(event.target.value)}
								placeholder="otto"
								autoComplete="off"
							/>
						</div>
						{error ? (
							<p className="captain-dialog-error" role="alert">
								{error}
							</p>
						) : null}
						<div className="captain-dialog-actions">
							<span className="captain-dialog-spacer" />
							<Dialog.Close asChild>
								<Button type="button" variant="ghost">
									Cancel
								</Button>
							</Dialog.Close>
							<Button type="submit">Save</Button>
						</div>
					</form>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
