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
import { InfrastructureStatements } from "./infrastructure-statements";
import {
	adjustInfrastructureUsageFn,
	infrastructureAllowanceAuditFn,
	infrastructureFleetCostsFn,
	infrastructureUsageFn,
	infrastructureUsersFn,
} from "./infrastructure-usage.fn";

const MICRO_USD_PER_STANDARD_MINUTE = 2204;
const minutes = (amount: number) =>
	(amount / MICRO_USD_PER_STANDARD_MINUTE).toLocaleString("en-US", {
		maximumFractionDigits: 1,
	});

const wholeMinutes = (amount: number) =>
	Math.max(
		0,
		Math.floor(amount / MICRO_USD_PER_STANDARD_MINUTE),
	).toLocaleString("en-US");

function UsageSummary({
	usage,
}: {
	usage: {
		remainingMicroUsd: number;
		allowanceMicroUsd: number;
		consumedMicroUsd: number;
		reservedMicroUsd: number;
	};
}) {
	const share =
		usage.allowanceMicroUsd > 0
			? Math.min(
					1,
					Math.max(0, usage.remainingMicroUsd / usage.allowanceMicroUsd),
				)
			: 0;
	return (
		<div className="settings-group settings-group-body">
			<div className="settings-usage-figure">
				{wholeMinutes(usage.remainingMicroUsd)}
				<small>of {wholeMinutes(usage.allowanceMicroUsd)} minutes left</small>
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: a styled bar; a native <meter> cannot hold the fill span */}
			<div
				className="settings-meter"
				data-tone={share < 0.15 ? "low" : undefined}
				role="meter"
				aria-label="Cloud minutes left"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(share * 100)}
			>
				<span style={{ width: `${share * 100}%` }} />
			</div>
			<p className="settings-row-meta">
				{wholeMinutes(usage.consumedMicroUsd)} used
				{usage.reservedMicroUsd > 0
					? ` · ${wholeMinutes(usage.reservedMicroUsd)} held for running machines`
					: ""}
			</p>
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
	const [kind, setKind] = useState<"grant" | "monthly_limit">("grant");
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
		const amountMicroUsd = Math.round(
			Number(amount) * MICRO_USD_PER_STANDARD_MINUTE,
		);
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
					<h3>Cloud minutes</h3>
					<p>
						Time your agents' machines run this month (UTC). Larger machines use
						minutes faster. Model usage is billed by your model provider.
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
								<SelectItem value="grant">Add credit this month</SelectItem>
								<SelectItem value="monthly_limit">
									Set monthly allowance
								</SelectItem>
							</SelectContent>
						</Select>
					</label>
					<label>
						Cloud minutes
						<input
							type="number"
							min="0"
							max="1000000"
							step="1"
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
						Grants are audited. They never bypass the fleet budget.
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
							{entry.kind === "grant"
								? "Credit added"
								: "Monthly allowance set"}
							: {minutes(entry.amountMicroUsd)} minutes
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
