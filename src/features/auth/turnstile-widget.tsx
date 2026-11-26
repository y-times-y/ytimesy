import type { CaptchaRenderProps } from "@better-auth-ui/react/plugins/captcha";
import { useEffect, useRef, useState } from "react";
import { authViewFromPath } from "#/domain/auth-funnel";
import { captureAnalytics } from "#/features/analytics/client";

type Turnstile = {
	render(
		element: HTMLElement,
		options: {
			sitekey: string;
			theme?: "dark" | "light" | "auto";
			appearance?: "always" | "execute" | "interaction-only";
			callback(token: string): void;
			"expired-callback"(): void;
			"error-callback"(): void;
		},
	): string;
	reset(widgetId: string): void;
	remove(widgetId: string): void;
};

declare global {
	interface Window {
		turnstile?: Turnstile;
	}
}

const SCRIPT =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<Turnstile> | undefined;

function loadTurnstile(): Promise<Turnstile> {
	if (window.turnstile) return Promise.resolve(window.turnstile);
	loading ??= new Promise<Turnstile>((resolve, reject) => {
		const script = document.createElement("script");
		script.src = SCRIPT;
		script.async = true;
		script.onload = () =>
			window.turnstile
				? resolve(window.turnstile)
				: reject(new Error("Turnstile did not load."));
		script.onerror = () => {
			loading = undefined;
			reject(new Error("Turnstile did not load."));
		};
		document.head.appendChild(script);
	});
	return loading;
}

/** Why the Cloudflare Turnstile check on email sign-up, sign-in and reset failed. */
export type TurnstileFailure = "script" | "challenge" | "expired";

export function turnstileFailureMessage(reason: TurnstileFailure): string {
	if (reason === "script")
		return "We could not load the security check. An ad blocker or a poor connection may be stopping it.";
	if (reason === "expired")
		return "The security check expired. Run it again to continue.";
	return "The security check did not complete. Run it again to continue.";
}

/** A visible failure with a retry, instead of a form that silently refuses. */
export function TurnstileProblem({
	reason,
	onRetry,
}: {
	reason: TurnstileFailure;
	onRetry(): void;
}) {
	return (
		<div role="alert" className="turnstile-problem text-sm text-destructive">
			<p>{turnstileFailureMessage(reason)}</p>
			<button type="button" className="underline" onClick={onRetry}>
				Try again
			</button>
		</div>
	);
}

/** The Cloudflare Turnstile challenge on email sign-up, sign-in and reset. */
export function TurnstileWidget({
	siteKey,
	setToken,
	clearToken,
	setReset,
}: CaptchaRenderProps & { siteKey: string }) {
	const container = useRef<HTMLDivElement>(null);
	const [failure, setFailure] = useState<TurnstileFailure | null>(null);
	const [attempt, setAttempt] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: attempt re-runs the check after a retry
	useEffect(() => {
		let widgetId: string | undefined;
		let turnstile: Turnstile | undefined;
		let cancelled = false;
		const fail = (reason: TurnstileFailure) => {
			clearToken();
			if (cancelled) return;
			setFailure(reason);
			captureAnalytics("auth_funnel", {
				view: authViewFromPath(window.location.pathname),
				step: "error",
				kind: "captcha_unavailable",
			});
		};
		setFailure(null);
		void loadTurnstile()
			.then((loaded) => {
				if (cancelled || !container.current) return;
				turnstile = loaded;
				widgetId = loaded.render(container.current, {
					sitekey: siteKey,
					theme: "dark",
					// Shown only when Cloudflare needs the person to do something; the
					// check otherwise runs unseen, so the forms carry no widget.
					appearance: "interaction-only",
					callback: (token) => {
						setFailure(null);
						setToken(token);
					},
					"expired-callback": () => fail("expired"),
					"error-callback": () => fail("challenge"),
				});
				setReset(() => {
					clearToken();
					if (widgetId) loaded.reset(widgetId);
				});
			})
			.catch(() => fail("script"));
		return () => {
			cancelled = true;
			setReset(null);
			if (turnstile && widgetId) turnstile.remove(widgetId);
		};
	}, [siteKey, setToken, clearToken, setReset, attempt]);
	return (
		<>
			<div ref={container} className="turnstile-widget" />
			{failure ? (
				<TurnstileProblem
					reason={failure}
					onRetry={() => {
						captureAnalytics("auth_funnel", {
							view: authViewFromPath(window.location.pathname),
							step: "retry",
						});
						setAttempt((n) => n + 1);
					}}
				/>
			) : null}
		</>
	);
}
