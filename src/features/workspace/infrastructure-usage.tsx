import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useRef, useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import type { UsageWindowState } from "#/domain/infrastructure-usage";
import { usageWarning } from "#/domain/usage-warning";
import { InfrastructureStatements } from "./infrastructure-statements";
import {
	adjustInfrastructureUsageFn,
	infrastructureAllowanceAuditFn,
	infrastructureFleetCostsFn,
	infrastructureUsageFn,
	infrastructureUsersFn,
} from "./infrastructure-usage.fn";
import { UsageWindowBars } from "./usage-windows";

const dollars = (amount: number) =>
	`$${(amount / 1_000_000).toLocaleString("en-US", {
		maximumFractionDigits: 2,
	})}`;

const ADJUSTMENT_LABELS: Record<string, string> = {
	five_hour_limit: "5-hour limit set",
	weekly_limit: "Weekly limit set",
	monthly_limit: "Monthly allowance set (no longer enforced)",
	grant: "Credit added (no longer enforced)",
};

function UsageSummary({
	usage,
}: {
	usage: { windows: readonly UsageWindowState[] };
}) {
	const warning = usageWarning(usage.windows);
	return (
		<div className="settings-group settings-group-body">
			<UsageWindowBars windows={usage.windows} />
			{warning ? (
				<p className="settings-usage-warning" role="status">
					{warning.message}
				</p>
			) : null}
		</div>
	);
}

const DISMISSED_USAGE_WARNING = "ytimesy:dismissed-usage-warning";

/**
 * Heads-up in the workspace once 80% of either cloud usage window is used,
 * and again when one runs out. Dismissing hides it for this browser session
 * until the next 10% step.
 */
export function UsageWarningBanner() {
	const readUsage = useServerFn(infrastructureUsageFn);
	const usage = useQuery({
		queryKey: ["infrastructure-usage"],
		queryFn: () => readUsage(),
		refetchInterval: 60_000,
		retry: false,
	});
	const warning = usage.data ? usageWarning(usage.data.windows) : null;
	const step = warning
		? `${warning.level}:${warning.window}:${Math.floor(warning.usedPercent / 10)}`
		: null;
	const [dismissed, setDismissed] = useState(() => {
		try {
			return sessionStorage.getItem(DISMISSED_USAGE_WARNING);
		} catch {
			return null;
		}
	});
	if (!warning || dismissed === step) return null;
	return (
		<div
			className="usage-warning-banner"
			data-level={warning.level}
			role="status"
		>
			<p>{warning.message}</p>
			<button
				type="button"
				onClick={() => {
					setDismissed(step);
					try {
						if (step) sessionStorage.setItem(DISMISSED_USAGE_WARNING, step);
					} catch {
						// Dismissal is a convenience; it may not persist.
					}
				}}
			>
				Dismiss
			</button>
		</div>
	);
}

export function InfrastructureUsage() {
	const readUsage = useServerFn(infrastructureUsageFn);
	const readUsers = useServerFn(infrastructureUsersFn);
	const readFleetCosts = useServerFn(infrastructureFleetCostsFn);
	const readAudit = useServerFn(infrastructureAllowanceAuditFn);
	const adjustUsage = useServerFn(adjustInfrastructureUsageFn);
	const cache = useQueryClient();
	const usage = useQuery({
		queryKey: ["infrastructure-usage"],
		queryFn: () => readUsage(),
		refetchInterval: 30_000,
	});
	const users = useQuery({
		queryKey: ["infrastructure-users"],
		queryFn: () => readUsers(),
		enabled: usage.data?.admin === true,
	});
	const [target, setTarget] = useState("self");
	const audit = useQuery({
		queryKey: ["infrastructure-allowance-audit"],
		queryFn: () => readAudit(),
		enabled: usage.data?.admin === true,
	});
	const fleet = useQuery({
		queryKey: ["infrastructure-fleet-costs"],
		queryFn: () => readFleetCosts(),
		enabled: usage.data?.admin === true,
		refetchInterval: 300_000,
	});
	const [kind, setKind] = useState<"five_hour_limit" | "weekly_limit">(
		"five_hour_limit",
	);
	const [amount, setAmount] = useState("");
	const [reason, setReason] = useState("");
	const pendingRequest = useRef<{ signature: string; id: string } | null>(null);
	const adjustment = useMutation({
		mutationFn: (data: Parameters<typeof adjustUsage>[0]["data"]) =>
			adjustUsage({ data }),
		onSuccess: () => {
			pendingRequest.current = null;
			void cache.invalidateQueries({ queryKey: ["infrastructure-usage"] });
			void cache.invalidateQueries({
				queryKey: ["infrastructure-allowance-audit"],
			});
			setAmount("");
			setReason("");
		},
	});
	function submit(event: FormEvent) {
		event.preventDefault();
		if (!usage.data) return;
		const amountMicroUsd = Math.round(Number(amount) * 1_000_000);
		if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd < 0) return;
		const userId = target === "self" ? usage.data.userId : target;
		const signature = JSON.stringify([userId, kind, amountMicroUsd, reason]);
		if (pendingRequest.current?.signature !== signature)
			pendingRequest.current = { signature, id: crypto.randomUUID() };
		adjustment.mutate({
			id: pendingRequest.current.id,
			userId,
			kind,
			amountMicroUsd,
			reason,
		});
	}
	return (
		<section className="settings-section" aria-label="Cloud execution usage">
			<header className="settings-section-head">
				<div>
					<h3>Cloud usage</h3>
					<p>
						Machine time your agents use, over a rolling 5-hour and a rolling
						weekly limit. Larger machines use it faster. At a limit, work
						already running finishes and new work waits until it refills. Model
						usage is billed by your model provider.
					</p>
				</div>
			</header>
			{usage.isPending ? (
				<p className="settings-copy">Checking usage…</p>
			) : null}
			{usage.error ? (
				<p role="alert">Cloud usage is unavailable. Please retry.</p>
			) : null}
			{usage.data ? <UsageSummary usage={usage.data} /> : null}
			{usage.data?.admin ? (
				<form onSubmit={submit} className="settings-usage-admin">
					<h4>Admin allowance controls</h4>
					<label htmlFor="usage-account">
						Account
						<Select value={target} onValueChange={setTarget}>
							<SelectTrigger id="usage-account" aria-label="Account">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="self">My account</SelectItem>
								{users.data
									?.filter((user) => user.id !== usage.data?.userId)
									.map((user) => (
										<SelectItem key={user.id} value={user.id}>
											{user.name || user.email}
										</SelectItem>
									))}
							</SelectContent>
						</Select>
					</label>
					<label htmlFor="usage-adjustment">
						Adjustment
						<Select
							value={kind}
							onValueChange={(value) => setKind(value as typeof kind)}
						>
							<SelectTrigger id="usage-adjustment" aria-label="Adjustment">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="five_hour_limit">
									Set 5-hour limit
								</SelectItem>
								<SelectItem value="weekly_limit">Set weekly limit</SelectItem>
							</SelectContent>
						</Select>
					</label>
					<label>
						Limit (USD)
						<input
							type="number"
							min="0"
							max="1000000"
							step="0.01"
							required
							value={amount}
							onChange={(event) => setAmount(event.target.value)}
						/>
					</label>
					<label>
						Reason
						<input
							required
							maxLength={500}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
						/>
					</label>
					<button
						type="submit"
						disabled={adjustment.isPending || users.isPending || users.isError}
					>
						Save allowance
					</button>
					{adjustment.isSuccess ? (
						<p role="status">Allowance updated.</p>
					) : null}
					{adjustment.error ? (
						<p role="alert">The allowance could not be updated.</p>
					) : null}
					<p className="settings-copy">
						Changes are audited. They never bypass the fleet budget.
					</p>
				</form>
			) : null}
			{fleet.data && usage.data?.admin ? (
				<section
					className="settings-usage-admin"
					aria-label="Fleet cost observations"
				>
					<h4>Fleet cost observations</h4>
					<p className="settings-copy">
						{fleet.data.activeVms} active of {fleet.data.vmCount} machines ·{" "}
						{fleet.data.snapshotCount} snapshots
					</p>
					<p className="settings-copy">
						Retail compute $
						{(fleet.data.computeHourlyMicroUsd / 1_000_000).toFixed(3)}/hour
						while currently active · retained disks $
						{(fleet.data.storageMonthlyMicroUsd / 1_000_000).toFixed(2)}/30 days
						if unchanged.
					</p>
					<p className="settings-copy">
						Includes the worker and legacy machines. Snapshot and transfer
						charges are unavailable; this is not an invoice or a total spending
						cap. Observed {new Date(fleet.data.observedAt).toLocaleString()}.
					</p>
				</section>
			) : null}
			{usage.data?.admin ? <InfrastructureStatements /> : null}
			{usage.data?.admin && audit.data?.length ? (
				<details className="settings-usage-admin">
					<summary>Recent allowance changes</summary>
					{audit.data.map((entry) => (
						<p key={entry.id} className="settings-copy">
							{users.data?.find((user) => user.id === entry.userId)?.name ??
								entry.userId}
							{" · "}
							{ADJUSTMENT_LABELS[entry.kind] ?? entry.kind}:{" "}
							{dollars(entry.amountMicroUsd)}
							{" · "}
							{entry.reason}
							{" · "}
							{new Date(entry.createdAt).toLocaleString()}
							{" · by "}
							{users.data?.find((user) => user.id === entry.actorId)?.name ??
								entry.actorId}
						</p>
					))}
				</details>
			) : null}
		</section>
	);
}
