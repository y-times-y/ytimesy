import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { Project, RepositoryChoice } from "../../domain/projects";
import { authClient } from "../auth/client";
import { IdentityGate } from "../auth/identity-gate";
import { requestJson } from "./api";

export function ProjectOnboarding() {
	return (
		<IdentityGate>
			<RepositorySetup />
		</IdentityGate>
	);
}
function RepositorySetup() {
	const session = authClient.useSession();
	const signedInAs =
		session.data?.user.email ?? session.data?.user.name ?? null;
	const [selected, setSelected] = useState<RepositoryChoice | null>(null);
	const [branch, setBranch] = useState("");
	const [callbackFailed, setCallbackFailed] = useState(false);
	useEffect(() => {
		setCallbackFailed(
			new URLSearchParams(window.location.search).get("connection") ===
				"failed",
		);
	}, []);
	const repositories = useQuery({
		queryKey: ["github", "repositories"],
		queryFn: () =>
			requestJson<{
				repositories: RepositoryChoice[];
				installationUrl: string;
			}>("/api/github/repositories"),
		retry: false,
	});
	const branches = useQuery({
		queryKey: [
			"github",
			"branches",
			selected?.installationId,
			selected?.repositoryId,
		],
		queryFn: () =>
			requestJson<string[]>(
				`/api/github/branches?installationId=${selected?.installationId}&repositoryId=${selected?.repositoryId}`,
			),
		enabled: !!selected,
		retry: false,
	});
	const connection = useMutation({
		mutationFn: () => requestJson<{ url: string }>("/api/github/connect", {}),
		onSuccess: ({ url }) => {
			window.location.assign(url);
		},
	});
	const save = useMutation({
		mutationFn: () =>
			requestJson<Project>("/api/projects", {
				installationId: selected?.installationId,
				repositoryId: selected?.repositoryId,
				branch,
			}),
		onSuccess: () => window.location.assign("/"),
	});
	const disconnect = useMutation({
		mutationFn: () =>
			requestJson<{ connected: boolean }>("/api/github/disconnect", {}),
		onSuccess: () => {
			setSelected(null);
			setBranch("");
			void repositories.refetch();
		},
	});
	return (
		<main className="onboarding-shell">
			<section className="onboarding-card repository-setup">
				<a href="/" className="brand">
					<img src="/brand/mark.svg" width="28" height="28" alt="" />
					<span className="brand-name">ytimesy</span>
				</a>
				<h1>Add a project</h1>
				<p>Choose a repository and a starting branch.</p>
				{callbackFailed && (
					<p role="alert">
						GitHub connection was canceled or expired. Try again.
					</p>
				)}
				{repositories.isPending && <p role="status">Loading repositories…</p>}
				{repositories.error && (
					<>
						<p role="status">{repositories.error.message}</p>
						<button
							type="button"
							className="setup-primary"
							disabled={connection.isPending}
							onClick={() => connection.mutate()}
						>
							{connection.isPending ? "Opening GitHub…" : "Connect GitHub"}
						</button>
					</>
				)}
				{repositories.data && (
					<>
						<label htmlFor="repository-choice">Repository</label>
						<select
							id="repository-choice"
							value={selected?.repositoryId ?? ""}
							onChange={(event) => {
								const repo =
									repositories.data.repositories.find(
										(item) => item.repositoryId === Number(event.target.value),
									) ?? null;
								setSelected(repo);
								setBranch(repo?.defaultBranch ?? "");
							}}
						>
							<option value="" disabled>
								{repositories.data.repositories.length
									? "Select repository"
									: "No writable repositories available"}
							</option>
							{repositories.data.repositories.map((repo) => (
								<option key={repo.repositoryId} value={repo.repositoryId}>
									{repo.fullName}
								</option>
							))}
						</select>
						<div className="setup-links">
							<a
								href={repositories.data.installationUrl}
								target="_blank"
								rel="noreferrer"
							>
								Manage repository access
							</a>
							<button
								type="button"
								onClick={() => {
									setSelected(null);
									setBranch("");
									void repositories.refetch();
								}}
							>
								Refresh
							</button>
						</div>
						{selected && (
							<>
								<label htmlFor="branch-choice">Branch</label>
								<select
									id="branch-choice"
									value={branch}
									disabled={branches.isPending}
									onChange={(event) => setBranch(event.target.value)}
								>
									{branches.isPending ? (
										<option>{selected.defaultBranch}</option>
									) : (
										branches.data?.map((name) => (
											<option key={name} value={name}>
												{name}
											</option>
										))
									)}
								</select>
								<button
									type="button"
									className="setup-primary"
									disabled={save.isPending || !branches.data?.includes(branch)}
									onClick={() => save.mutate()}
								>
									{save.isPending ? "Adding project…" : "Add project"}
								</button>
							</>
						)}
					</>
				)}
				{(connection.error ||
					branches.error ||
					save.error ||
					disconnect.error) && (
					<p role="alert">
						{connection.error?.message ||
							branches.error?.message ||
							save.error?.message ||
							disconnect.error?.message}
					</p>
				)}
				{repositories.data && (
					<button
						type="button"
						className="setup-back"
						disabled={disconnect.isPending}
						onClick={() => disconnect.mutate()}
					>
						{disconnect.isPending ? "Disconnecting…" : "Disconnect GitHub"}
					</button>
				)}
				<a className="setup-back" href="/">
					Back to workspace
				</a>
				{signedInAs && <p>Signed in as {signedInAs}</p>}
				<button
					type="button"
					className="setup-back"
					onClick={async () => {
						await authClient.signOut();
						window.location.assign("/");
					}}
				>
					Sign out
				</button>
			</section>
		</main>
	);
}
