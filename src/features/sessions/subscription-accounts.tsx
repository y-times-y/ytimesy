import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
	accountChip,
	lastUsedLabel,
	type SubscriptionProvider,
} from "#/domain/subscription-accounts";
import type { PublicSubscriptionAccount } from "#/server/adapters/subscription-accounts";
import { ChatgptSignIn } from "./chatgpt-sign-in";
import {
	addClaudeAccountFn,
	getChatAccountPinFn,
	getSubscriptionAccounts,
	pinChatAccountFn,
	removeSubscriptionAccountFn,
	renameSubscriptionAccountFn,
	reorderSubscriptionAccountsFn,
} from "./subscription-accounts.fn";

export const SUBSCRIPTION_ACCOUNTS_KEY = ["subscription-accounts"];

const PROVIDER_NAME: Record<"codex" | "claude", string> = {
	codex: "ChatGPT (Codex)",
	claude: "Claude",
};

/** The accounts, and every change to them; one list is shared by Settings and the picker. */
export function useSubscriptionAccounts() {
	const queryClient = useQueryClient();
	const read = useServerFn(getSubscriptionAccounts);
	const rename = useServerFn(renameSubscriptionAccountFn);
	const remove = useServerFn(removeSubscriptionAccountFn);
	const reorder = useServerFn(reorderSubscriptionAccountsFn);
	const addClaude = useServerFn(addClaudeAccountFn);
	const accounts = useQuery({
		queryKey: SUBSCRIPTION_ACCOUNTS_KEY,
		queryFn: () => read(),
		staleTime: 30_000,
	});
	const refresh = (data: PublicSubscriptionAccount[]) => {
		queryClient.setQueryData(SUBSCRIPTION_ACCOUNTS_KEY, data);
		void queryClient.invalidateQueries({ queryKey: ["agent-model-catalog"] });
	};
	return {
		accounts,
		reload: () =>
			queryClient.invalidateQueries({ queryKey: SUBSCRIPTION_ACCOUNTS_KEY }),
		rename: useMutation({
			mutationFn: (input: {
				provider: SubscriptionProvider;
				accountId: string;
				label: string;
			}) => rename({ data: input as never }),
			onSuccess: refresh,
		}),
		remove: useMutation({
			mutationFn: (input: {
				provider: SubscriptionProvider;
				accountId: string;
			}) => remove({ data: input as never }),
			onSuccess: refresh,
		}),
		reorder: useMutation({
			mutationFn: (input: {
				provider: SubscriptionProvider;
				order: string[];
			}) => reorder({ data: input as never }),
			onSuccess: refresh,
		}),
		addClaude: useMutation({
			mutationFn: (input: { token: string; label: string }) =>
				addClaude({ data: input }),
			onSuccess: refresh,
		}),
	};
}

const formatClock = (epochMs: number) =>
	new Date(epochMs).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});

/**
 * Settings > Models: the accounts of each plan provider, with their status,
 * order and an "Add another account" flow. Shows a provider once it has an
 * account; the first one is connected in the rows above.
 */
export function SubscriptionAccountsSection() {
	const hub = useSubscriptionAccounts();
	const all = hub.accounts.data ?? [];
	const providers = (["codex", "claude"] as const).filter((provider) =>
		all.some((a) => a.provider === provider),
	);
	if (!providers.length) return null;
	const now = Date.now();
	const recent = [...all]
		.filter((a) => a.lastUsedAt !== null)
		.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
	return (
		<section className="settings-section" aria-label="Subscription accounts">
			<header className="settings-section-head">
				<div>
					<h3>Accounts</h3>
					<p>
						More than one plan per provider? Chats use them in your order and
						move to the next when one is used up.
					</p>
				</div>
			</header>
			{providers.map((provider) => (
				<ProviderAccounts
					key={provider}
					provider={provider}
					accounts={all.filter((a) => a.provider === provider)}
					hub={hub}
					now={now}
				/>
			))}
			{recent ? (
				<p className="account-summary">
					Most recent: {recent.label} (
					{PROVIDER_NAME[recent.provider as "codex"]}
					). {lastUsedLabel(recent.lastUsedAt, now)}.
				</p>
			) : null}
			<p className="account-note">
				Use accounts you own; follow each provider's terms.
			</p>
		</section>
	);
}

function ProviderAccounts({
	provider,
	accounts,
	hub,
	now,
}: {
	provider: "codex" | "claude";
	accounts: PublicSubscriptionAccount[];
	hub: ReturnType<typeof useSubscriptionAccounts>;
	now: number;
}) {
	const move = (index: number, by: -1 | 1) => {
		const order = accounts.map((a) => a.id);
		const target = index + by;
		if (target < 0 || target >= order.length) return;
		[order[index], order[target]] = [
			order[target] as string,
			order[index] as string,
		];
		hub.reorder.mutate({ provider, order });
	};
	return (
		<div className="account-provider">
			<h3 className="account-provider-name">{PROVIDER_NAME[provider]}</h3>
			<ul className="settings-group account-list">
				{accounts.map((account, index) => (
					<AccountRow
						key={account.id}
						account={account}
						now={now}
						first={index === 0}
						last={index === accounts.length - 1}
						onMove={(by) => move(index, by)}
						hub={hub}
					/>
				))}
			</ul>
			<AddAccount provider={provider} hub={hub} />
			{hub.reorder.error ? (
				<p role="alert">{hub.reorder.error.message}</p>
			) : null}
		</div>
	);
}

function AccountRow({
	account,
	now,
	first,
	last,
	onMove,
	hub,
}: {
	account: PublicSubscriptionAccount;
	now: number;
	first: boolean;
	last: boolean;
	onMove: (by: -1 | 1) => void;
	hub: ReturnType<typeof useSubscriptionAccounts>;
}) {
	const [renaming, setRenaming] = useState(false);
	const [name, setName] = useState(account.label);
	const [confirming, setConfirming] = useState(false);
	const chip = accountChip(account, now, formatClock);
	const meta = [
		account.planType ? `${account.planType} plan` : null,
		account.email,
		lastUsedLabel(account.lastUsedAt, now),
	]
		.filter(Boolean)
		.join(" · ");
	const submit = (event: FormEvent) => {
		event.preventDefault();
		hub.rename.mutate(
			{
				provider: account.provider,
				accountId: account.id,
				label: name,
			},
			{ onSuccess: () => setRenaming(false) },
		);
	};
	return (
		<li className="settings-row account-row" aria-label={account.label}>
			<div className="settings-row-main">
				<div className="settings-row-text">
					{renaming ? (
						<form className="account-rename" onSubmit={submit}>
							<input
								// Opened by the Rename click.
								// biome-ignore lint/a11y/noAutofocus: the field the click asked for.
								autoFocus
								aria-label="Account name"
								maxLength={60}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
							<button type="submit" className="settings-secondary">
								Save
							</button>
							<button
								type="button"
								className="settings-secondary"
								onClick={() => setRenaming(false)}
							>
								Cancel
							</button>
						</form>
					) : (
						<span className="settings-row-title">
							{account.label}
							{account.active ? (
								<span className="account-inuse"> · in use</span>
							) : null}
						</span>
					)}
					<span className="settings-row-meta">{meta}</span>
				</div>
			</div>
			<div className="settings-row-actions account-actions">
				<span className="account-chip" data-tone={chip.tone}>
					{chip.text}
				</span>
				<button
					type="button"
					className="settings-secondary account-move"
					aria-label={`Move ${account.label} earlier`}
					disabled={first}
					onClick={() => onMove(-1)}
				>
					<ArrowUp size={14} />
				</button>
				<button
					type="button"
					className="settings-secondary account-move"
					aria-label={`Move ${account.label} later`}
					disabled={last}
					onClick={() => onMove(1)}
				>
					<ArrowDown size={14} />
				</button>
				{confirming ? (
					<>
						<button
							type="button"
							className="settings-secondary"
							onClick={() => setConfirming(false)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="settings-danger"
							disabled={hub.remove.isPending}
							onClick={() =>
								hub.remove.mutate({
									provider: account.provider,
									accountId: account.id,
								})
							}
						>
							Disconnect
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							className="settings-secondary"
							onClick={() => {
								setName(account.label);
								setRenaming(true);
							}}
						>
							Rename
						</button>
						<button
							type="button"
							className="settings-secondary"
							onClick={() => setConfirming(true)}
						>
							Disconnect
						</button>
					</>
				)}
			</div>
			{hub.rename.error && renaming ? (
				<p role="alert">{hub.rename.error.message}</p>
			) : null}
		</li>
	);
}

/** "Add another account": the same connect flow as the first account, with a name. */
function AddAccount({
	provider,
	hub,
}: {
	provider: "codex" | "claude";
	hub: ReturnType<typeof useSubscriptionAccounts>;
}) {
	const [open, setOpen] = useState(false);
	const [label, setLabel] = useState("");
	const [token, setToken] = useState("");
	const close = () => {
		setOpen(false);
		setLabel("");
		setToken("");
	};
	if (!open)
		return (
			<button
				type="button"
				className="settings-secondary account-add"
				onClick={() => setOpen(true)}
			>
				Add another account
			</button>
		);
	const named = label.trim().length > 0;
	return (
		<div className="account-add-flow">
			<input
				// Opened by the click on "Add another account".
				// biome-ignore lint/a11y/noAutofocus: the field the click asked for.
				autoFocus
				aria-label="Name for this account"
				placeholder="Name, e.g. Work"
				maxLength={60}
				value={label}
				onChange={(event) => setLabel(event.target.value)}
			/>
			{provider === "claude" ? (
				<form
					className="claude-token-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (named && token.trim())
							hub.addClaude.mutate(
								{ token: token.trim(), label: label.trim() },
								{ onSuccess: close },
							);
					}}
				>
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						aria-label="Claude setup token"
						placeholder="sk-ant-oat01-…"
						value={token}
						disabled={hub.addClaude.isPending}
						onChange={(event) => setToken(event.target.value)}
					/>
					<button
						type="submit"
						className="chatgpt-sign-in-button"
						disabled={!named || !token.trim() || hub.addClaude.isPending}
					>
						{hub.addClaude.isPending ? "Checking…" : "Add"}
					</button>
					<small>
						Run claude setup-token while signed in to this other account, then
						paste the token it prints.
					</small>
				</form>
			) : named ? (
				<ChatgptSignIn
					addAs={label.trim()}
					label="Sign in with ChatGPT"
					onConnected={() => {
						void hub.reload();
						close();
					}}
				/>
			) : (
				<small>Name it first, then sign in with that ChatGPT account.</small>
			)}
			{hub.addClaude.error ? (
				<p role="alert">{hub.addClaude.error.message}</p>
			) : null}
			<button type="button" className="settings-secondary" onClick={close}>
				Cancel
			</button>
		</div>
	);
}

/**
 * In the model picker: which account of the plan this chat uses, or Auto.
 * Shown only with two or more accounts of the provider and a saved chat; the
 * picker still lists the provider once.
 */
export function AccountPin({
	provider,
	sessionId,
}: {
	provider: "codex" | "claude";
	sessionId: string | null | undefined;
}) {
	const queryClient = useQueryClient();
	const { accounts } = useSubscriptionAccounts();
	const readPin = useServerFn(getChatAccountPinFn);
	const writePin = useServerFn(pinChatAccountFn);
	const key = ["chat-account-pin", sessionId];
	const mine = (accounts.data ?? []).filter((a) => a.provider === provider);
	const pin = useQuery({
		queryKey: key,
		queryFn: () => readPin({ data: { sessionId: sessionId as string } }),
		enabled: Boolean(sessionId) && mine.length > 1,
		staleTime: 30_000,
	});
	const change = useMutation({
		mutationFn: (accountId: string | null) =>
			writePin({ data: { sessionId: sessionId as string, accountId } }),
		onSuccess: (data) => queryClient.setQueryData(key, data),
	});
	if (!sessionId || mine.length < 2) return null;
	const now = Date.now();
	const value = pin.data?.accountId ?? "";
	return (
		<label className="account-pin">
			<span>Account</span>
			<select
				aria-label={`${PROVIDER_NAME[provider]} account for this chat`}
				value={mine.some((a) => a.id === value) ? value : ""}
				disabled={change.isPending}
				onChange={(event) => change.mutate(event.target.value || null)}
			>
				<option value="">Auto</option>
				{mine.map((a) => (
					<option key={a.id} value={a.id}>
						{a.label} · {accountChip(a, now, formatClock).text}
					</option>
				))}
			</select>
		</label>
	);
}
