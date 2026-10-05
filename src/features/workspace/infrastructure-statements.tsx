import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { type ChangeEvent, useRef, useState } from "react";
import {
	infrastructureStatementSchema,
	statementCostCoverage,
} from "#/domain/infrastructure-statement";
import {
	importInfrastructureStatementFn,
	infrastructureStatementsFn,
} from "./infrastructure-usage.fn";

const dollars = (amount: number | null) =>
	amount === null ? "Unknown" : `$${(amount / 1_000_000).toFixed(2)}`;

export function InfrastructureStatements() {
	const readStatements = useServerFn(infrastructureStatementsFn);
	const importStatement = useServerFn(importInfrastructureStatementFn);
	const cache = useQueryClient();
	const [fileError, setFileError] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);
	const statements = useQuery({
		queryKey: ["infrastructure-statements"],
		queryFn: () => readStatements(),
	});
	const importer = useMutation({
		mutationFn: (data: Parameters<typeof importStatement>[0]["data"]) =>
			importStatement({ data }),
		onSuccess: () => {
			void cache.invalidateQueries({ queryKey: ["infrastructure-statements"] });
		},
	});
	async function upload(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		setFileError(false);
		importer.reset();
		try {
			if (file.size > 16_384) throw new Error("Statement is too large.");
			const data = infrastructureStatementSchema.parse(
				JSON.parse(await file.text()),
			);
			importer.mutate(data);
		} catch {
			setFileError(true);
		}
	}
	return (
		<details className="settings-usage-admin">
			<summary>Provider billing statements</summary>
			<p className="settings-copy">
				Finalized Freestyle usage before credits and tax. Imported by an
				administrator, not independently verified. These totals are separate
				from the live compute allowance.
			</p>
			<input
				ref={fileInput}
				hidden
				type="file"
				accept="application/json,.json"
				aria-label="Billing statement JSON"
				disabled={importer.isPending}
				onChange={(event) => void upload(event)}
			/>
			<button
				type="button"
				disabled={importer.isPending}
				onClick={() => fileInput.current?.click()}
			>
				{importer.isPending ? "Recording statement…" : "Import statement"}
			</button>
			{fileError || importer.error ? (
				<p role="alert">
					The statement could not be imported. Check the format, totals, and
					whether this period was already recorded.
				</p>
			) : null}
			{importer.isSuccess ? <p role="status">Statement recorded.</p> : null}
			{statements.error ? (
				<p role="alert">Billing statements could not be loaded.</p>
			) : null}
			{statements.data?.length === 0 ? (
				<p className="settings-copy">
					No finalized statements imported. Snapshot and transfer charges remain
					unknown.
				</p>
			) : null}
			{statements.data?.map(({ statement, importedAt, importedBy }) => (
				<div key={`${statement.accountId}:${statement.sourceId}`}>
					<p className="settings-copy">
						{statement.accountId} · {statement.sourceId} ·{" "}
						{new Date(statement.periodStart).toLocaleDateString()}–
						{new Date(statement.periodEnd).toLocaleDateString()} (end exclusive)
					</p>
					<p className="settings-copy">
						Compute {dollars(statement.computeMicroUsd)} · Disks{" "}
						{dollars(statement.diskMicroUsd)} · Snapshots{" "}
						{dollars(statement.snapshotMicroUsd)} · Transfer{" "}
						{dollars(statement.transferMicroUsd)} · Other{" "}
						{dollars(statement.otherMicroUsd)} · Gross{" "}
						{dollars(statement.grossMicroUsd)}
					</p>
					{statementCostCoverage(statement).unclassifiedMicroUsd > 0 ? (
						<p className="settings-copy">
							Not itemized:{" "}
							{dollars(statementCostCoverage(statement).unclassifiedMicroUsd)}
						</p>
					) : null}
					<p className="settings-copy">
						Imported {new Date(importedAt).toLocaleString()} by {importedBy}
					</p>
				</div>
			))}
		</details>
	);
}
