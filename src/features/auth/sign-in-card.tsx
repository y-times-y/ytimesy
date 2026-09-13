import { type FormEvent, useEffect, useState } from "react";
import { authErrorMessage, isUnverifiedEmailError } from "./auth-error";
import { authClient } from "./client";

type AuthView = "sign-in" | "sign-up" | "verify-email";
type PendingMethod = "google" | "github" | "email" | "resend" | "";

export function SignInCard({ sessionError }: { sessionError?: string }) {
	const [view, setView] = useState<AuthView>("sign-in");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [pending, setPending] = useState<PendingMethod>("");

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		if (params.get("error") !== "email_not_verified") return;
		setError("Verify your email before signing in.");
		params.delete("error");
		const next = `${window.location.pathname}${params.size ? `?${params}` : ""}`;
		window.history.replaceState(null, "", next);
	}, []);

	async function signInSocial(provider: "google" | "github") {
		setPending(provider);
		setError("");
		try {
			const result = await authClient.signIn.social({
				provider,
				callbackURL: "/",
				errorCallbackURL: "/",
			});
			if (result.error) {
				setError(
					authErrorMessage(
						result.error,
						provider === "google"
							? "Google sign-in is not available yet."
							: "GitHub sign-in could not start. Please try again.",
					),
				);
				setPending("");
			}
		} catch {
			setError(
				provider === "google"
					? "Google sign-in is not available yet."
					: "GitHub sign-in could not start. Please try again.",
			);
			setPending("");
		}
	}

	async function submitEmail(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setPending("email");
		setError("");
		try {
			const result =
				view === "sign-up"
					? await authClient.signUp.email({
							name: name.trim(),
							email,
							password,
							callbackURL: "/",
						})
					: await authClient.signIn.email({
							email,
							password,
							callbackURL: "/",
						});
			if (result.error) {
				if (isUnverifiedEmailError(result.error)) {
					setView("verify-email");
					setError("");
					setPending("");
					return;
				}
				setError(
					authErrorMessage(
						result.error,
						view === "sign-up"
							? "Could not create this account. Please try again."
							: "Could not sign in. Please try again.",
					),
				);
				setPending("");
				return;
			}
			if (view === "sign-up") {
				setView("verify-email");
				setPending("");
				return;
			}
			window.location.assign("/");
		} catch {
			setError("Could not reach authentication. Please try again.");
			setPending("");
		}
	}

	async function resendVerification() {
		setPending("resend");
		setError("");
		try {
			const result = await authClient.sendVerificationEmail({
				email,
				callbackURL: "/",
			});
			if (result.error)
				setError(
					authErrorMessage(
						result.error,
						"Could not send a verification email. Please try again.",
					),
				);
		} catch {
			setError("Could not send a verification email. Please try again.");
		} finally {
			setPending("");
		}
	}

	if (view === "verify-email")
		return (
			<section className="onboarding-card">
				<BrandMark />
				<h1>Check your email</h1>
				<p>
					We sent a verification link to {email}. Open it to finish signing in.
				</p>
				<button
					className="setup-secondary"
					type="button"
					disabled={pending !== ""}
					onClick={() => void resendVerification()}
				>
					{pending === "resend" ? "Sending…" : "Resend email"}
				</button>
				<button
					className="setup-back"
					type="button"
					disabled={pending !== ""}
					onClick={() => {
						setView("sign-in");
						setError("");
					}}
				>
					Back to sign in
				</button>
				{error || sessionError ? (
					<p role="alert">{error || sessionError}</p>
				) : null}
			</section>
		);

	return (
		<section className="onboarding-card">
			<BrandMark />
			<h1>{view === "sign-up" ? "Create account" : "Sign in"}</h1>
			<p>
				{view === "sign-up"
					? "Use Google, GitHub, or email. Email accounts need a verified inbox."
					: "Use Google, GitHub, or your email and password."}
			</p>
			<div className="auth-methods">
				<button
					className="setup-secondary"
					type="button"
					disabled={pending !== ""}
					onClick={() => void signInSocial("google")}
				>
					{pending === "google" ? "Opening Google…" : "Continue with Google"}
				</button>
				<button
					className="setup-secondary"
					type="button"
					disabled={pending !== ""}
					onClick={() => void signInSocial("github")}
				>
					{pending === "github" ? "Opening GitHub…" : "Continue with GitHub"}
				</button>
			</div>
			<div className="auth-divider">or</div>
			<form
				className="auth-fields"
				onSubmit={(event) => void submitEmail(event)}
			>
				{view === "sign-up" ? (
					<label>
						Name
						<input
							autoComplete="name"
							name="name"
							onChange={(event) => setName(event.target.value)}
							required
							type="text"
							value={name}
						/>
					</label>
				) : null}
				<label>
					Email
					<input
						autoComplete="email"
						inputMode="email"
						name="email"
						onChange={(event) => setEmail(event.target.value)}
						required
						type="email"
						value={email}
					/>
				</label>
				<label>
					Password
					<input
						autoComplete={
							view === "sign-up" ? "new-password" : "current-password"
						}
						minLength={8}
						name="password"
						onChange={(event) => setPassword(event.target.value)}
						required
						type="password"
						value={password}
					/>
				</label>
				<button
					className="setup-primary"
					disabled={pending !== ""}
					type="submit"
				>
					{pending === "email"
						? view === "sign-up"
							? "Creating account…"
							: "Signing in…"
						: view === "sign-up"
							? "Create account"
							: "Sign in"}
				</button>
			</form>
			<p className="auth-switch">
				{view === "sign-up" ? (
					<>
						Already have an account?{" "}
						<button
							type="button"
							disabled={pending !== ""}
							onClick={() => {
								setView("sign-in");
								setError("");
							}}
						>
							Sign in
						</button>
					</>
				) : (
					<>
						Need an account?{" "}
						<button
							type="button"
							disabled={pending !== ""}
							onClick={() => {
								setView("sign-up");
								setError("");
							}}
						>
							Create one
						</button>
					</>
				)}
			</p>
			{error || sessionError ? (
				<p role="alert">{error || sessionError}</p>
			) : null}
		</section>
	);
}

function BrandMark() {
	return (
		<a href="/" className="brand">
			<img src="/brand/mark.svg" width="32" height="32" alt="" />
			<span className="brand-name">ytimesy</span>
		</a>
	);
}
