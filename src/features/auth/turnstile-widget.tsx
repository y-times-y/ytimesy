import type { CaptchaRenderProps } from "@better-auth-ui/react/plugins/captcha";
import { useEffect, useRef } from "react";

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

/** The Cloudflare Turnstile challenge on email sign-up, sign-in and reset. */
export function TurnstileWidget({
	siteKey,
	setToken,
	clearToken,
	setReset,
}: CaptchaRenderProps & { siteKey: string }) {
	const container = useRef<HTMLDivElement>(null);
	useEffect(() => {
		let widgetId: string | undefined;
		let turnstile: Turnstile | undefined;
		let cancelled = false;
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
					callback: setToken,
					"expired-callback": clearToken,
					"error-callback": clearToken,
				});
				setReset(() => {
					clearToken();
					if (widgetId) loaded.reset(widgetId);
				});
			})
			.catch(() => clearToken());
		return () => {
			cancelled = true;
			setReset(null);
			if (turnstile && widgetId) turnstile.remove(widgetId);
		};
	}, [siteKey, setToken, clearToken, setReset]);
	return <div ref={container} className="turnstile-widget" />;
}
