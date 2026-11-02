import type { ErrorComponentProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Wordmark } from "#/components/brand/wordmark";
import { OnboardingShell } from "../auth/onboarding-shell";
import { NotFoundPage } from "../landing/landing-page";

function AppStatus({
	title,
	detail,
	children,
}: {
	title: string;
	detail: string;
	children?: ReactNode;
}) {
	return (
		<OnboardingShell>
			<section className="onboarding-card">
				<a href="/" className="brand" aria-label="Y times Y home">
					<Wordmark />
				</a>
				<h1>{title}</h1>
				<p>{detail}</p>
				{children}
			</section>
		</OnboardingShell>
	);
}

export function AppNotFound() {
	return <NotFoundPage />;
}

export function AppError({ error, reset }: ErrorComponentProps) {
	return (
		<AppStatus title="Something went wrong" detail={appErrorDetail(error)}>
			{reset ? (
				<button type="button" className="setup-primary" onClick={reset}>
					Try again
				</button>
			) : null}
			<a className="setup-back" href="/">
				Go home
			</a>
		</AppStatus>
	);
}

export function appErrorDetail(error: unknown) {
	if (error instanceof Error && isUserFacingAppError(error.message)) {
		return error.message.trim();
	}
	return "Try again, or go home.";
}

function isUserFacingAppError(message: string) {
	const text = message.trim();
	if (!text || text.length > 140) return false;
	if (!/\s/.test(text)) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal escape sequences in user-facing error copy.
	return !/parse_error|transform failed|expected ['`]|ansi|src\/|\.tsx?:|node_modules|stack|exception|at \S+\s+\(|\u001b|\[\d{1,3}m/i.test(
		text,
	);
}
