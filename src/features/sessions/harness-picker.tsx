import { Check, ChevronDown, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { AgentConnection } from "#/domain/agent-connection";
import type { AgentProviderId } from "#/domain/agent-provider";
import {
	type HarnessAccess,
	harnessRequiresAccountLogin,
	offeredHarnessAccess,
} from "#/domain/harness-access";
import { AgentProviderMark } from "./agent-provider-mark";

export function HarnessPicker({
	harnessId,
	connection,
	apiKeyHints,
	busy,
	onHarnessIdChange,
	onConnect,
	onSaveApiKey,
	snapshotAvailable = false,
}: {
	harnessId: AgentProviderId;
	connection: AgentConnection;
	apiKeyHints: Readonly<Partial<Record<AgentProviderId, string>>>;
	busy: boolean;
	onHarnessIdChange: (id: AgentProviderId) => void;
	onConnect: () => void;
	onSaveApiKey: (harnessId: AgentProviderId, apiKey: string) => void;
	snapshotAvailable?: boolean;
}) {
	const options = offeredHarnessAccess(connection, apiKeyHints, {
		codexSnapshotAvailable: snapshotAvailable,
	});
	const selected =
		options.find((option) => option.provider.id === harnessId) ?? options[0];
	const [open, setOpen] = useState(false);
	const authorizing =
		connection.status === "awaiting_device_code" &&
		connection.provider === harnessId;

	useEffect(() => {
		if (authorizing) setOpen(true);
	}, [authorizing]);

	if (!selected) return null;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				id="session-harness-select"
				className="composer-select harness-select"
				data-muted={selected.muted ? "true" : undefined}
				aria-label="Harness"
				title={
					busy && selected.subscriptionActionLabel === "Resume"
						? "Resuming the saved ChatGPT workspace"
						: selected.muted
							? selected.statusLabel === "Saved workspace"
								? selected.summary
								: harnessRequiresAccountLogin(selected.provider.id)
									? `${selected.provider.name} is not signed in`
									: `${selected.provider.name} is not connected`
							: selected.provider.name
				}
			>
				<AgentProviderMark provider={selected.provider.id} size={16} />
				<span>{selected.provider.name}</span>
				<ChevronDown className="size-3" />
			</PopoverTrigger>
			<PopoverContent
				side="top"
				className="harness-picker"
				onOpenAutoFocus={(event) => {
					if (authorizing) event.preventDefault();
				}}
			>
				<p className="harness-picker-label">Harness</p>
				<div
					className="harness-picker-list"
					role="listbox"
					aria-label="Harness"
				>
					{options.map((option) => (
						<HarnessChoice
							key={option.provider.id}
							option={option}
							selected={option.provider.id === harnessId}
							busy={busy}
							onSelect={() => {
								onHarnessIdChange(option.provider.id);
								if (!option.muted) setOpen(false);
							}}
							onConnect={onConnect}
							onSaveApiKey={onSaveApiKey}
						/>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}

function HarnessChoice({
	option,
	selected,
	busy,
	onSelect,
	onConnect,
	onSaveApiKey,
}: {
	option: HarnessAccess;
	selected: boolean;
	busy: boolean;
	onSelect: () => void;
	onConnect: () => void;
	onSaveApiKey: (harnessId: AgentProviderId, apiKey: string) => void;
}) {
	const [draft, setDraft] = useState("");
	const [copied, setCopied] = useState(false);
	const showAuth = selected && option.readiness !== "ready";

	async function copyCode(code: string) {
		try {
			await navigator.clipboard.writeText(code);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			setCopied(false);
		}
	}

	return (
		<div
			className="harness-choice"
			data-selected={selected ? "true" : undefined}
			data-muted={option.muted ? "true" : undefined}
			data-readiness={option.readiness}
		>
			<button
				type="button"
				role="option"
				aria-selected={selected}
				className="harness-choice-select"
				onClick={onSelect}
			>
				<span className="harness-choice-mark">
					<AgentProviderMark provider={option.provider.id} size={20} />
				</span>
				<span className="harness-choice-copy">
					<span className="harness-choice-name">{option.provider.name}</span>
					<span className="harness-choice-status">{option.statusLabel}</span>
				</span>
			</button>
			{showAuth ? (
				<div className="harness-choice-auth">
					<p>{option.summary}</p>
					{option.userCode ? (
						<div className="harness-choice-code">
							<code>{option.userCode}</code>
							<button
								type="button"
								onClick={() => void copyCode(option.userCode ?? "")}
								aria-label={copied ? "Code copied" : "Copy code"}
							>
								{copied ? <Check size={14} /> : <Copy size={14} />}
								{copied ? "Copied" : "Copy"}
							</button>
						</div>
					) : null}
					{option.subscriptionAction && option.verificationUrl ? (
						<a
							className="harness-choice-action"
							href={option.verificationUrl}
							target="_blank"
							rel="noreferrer"
						>
							{option.subscriptionActionLabel}
						</a>
					) : option.subscriptionAction ? (
						<button
							type="button"
							className="harness-choice-action"
							onClick={onConnect}
							disabled={busy}
						>
							{busy
								? option.subscriptionAction === "connect"
									? "Connecting…"
									: option.subscriptionActionLabel === "Resume"
										? "Resuming…"
										: "Signing in…"
								: option.subscriptionActionLabel}
						</button>
					) : null}
					<form
						className="harness-key-form"
						onSubmit={(event) => {
							event.preventDefault();
							if (!draft.trim()) return;
							onSaveApiKey(option.provider.id, draft);
							setDraft("");
						}}
					>
						<label
							className="sr-only"
							htmlFor={`harness-key-${option.provider.id}`}
						>
							{option.provider.name} API key
						</label>
						<input
							id={`harness-key-${option.provider.id}`}
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder={
								option.apiKeyHint
									? `Replace key ${option.apiKeyHint}`
									: "API key"
							}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
						/>
						<button type="submit" disabled={busy || !draft.trim()}>
							Save key
						</button>
					</form>
				</div>
			) : null}
		</div>
	);
}
