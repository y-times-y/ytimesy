import type { ErrorComponentProps } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
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
	useEffect(() => {
		reportAppError(error);
		// A chat open when its session ended (signed out elsewhere, expired,
		// revoked) can fail on the first data that comes back without it:
		// a fresh load shows sign-in, so go there instead of this card.
		void reloadWhenSignedOut();
	}, [error]);
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

const SIGNED_OUT_RELOAD_KEY = "ytimesy-signed-out-reload";

/** Reloads once (not again within a minute) when the browser has no session. */
export async function reloadWhenSignedOut(
	fetchSession: () => Promise<Response> = () =>
		fetch("/api/auth/get-session", {
			credentials: "same-origin",
			cache: "no-store",
		}),
	page: {
		readonly reload: () => void;
		readonly storage: Pick<Storage, "getItem" | "setItem"> | null;
		readonly now: () => number;
	} = {
		reload: () => window.location.reload(),
		storage: typeof sessionStorage === "undefined" ? null : sessionStorage,
		now: () => Date.now(),
	},
): Promise<boolean> {
	try {
		const response = await fetchSession();
		if (!response.ok) return false;
		if ((await response.json()) !== null) return false;
	} catch {
		return false;
	}
	const last = Number(page.storage?.getItem(SIGNED_OUT_RELOAD_KEY) ?? 0);
	if (page.now() - last < 60_000) return false;
	page.storage?.setItem(SIGNED_OUT_RELOAD_KEY, String(page.now()));
	page.reload();
	return true;
}

/** Sends the error's message and stack (never page data) to the server log. */
function reportAppError(error: unknown) {
	if (typeof window === "undefined") return;
	try {
		const body = JSON.stringify({
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? (error.stack ?? "") : "",
			path: window.location.pathname,
			build: document.documentElement.dataset.build ?? "",
		});
		const blob = new Blob([body], { type: "application/json" });
		if (!navigator.sendBeacon?.("/api/client-error", blob))
			void fetch("/api/client-error", {
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
				keepalive: true,
			}).catch(() => {});
	} catch {}
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
	// A JavaScript fault, not a message for people.
	if (
		/cannot read propert|is not a function|is not defined|is not iterable|undefined|null\b/i.test(
			text,
		)
	)
		return false;
	if (!/\s/.test(text)) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject terminal escape sequences in user-facing error copy.
	return !/parse_error|transform failed|expected ['`]|ansi|src\/|\.tsx?:|node_modules|stack|exception|at \S+\s+\(|\u001b|\[\d{1,3}m/i.test(
		text,
	);
}
