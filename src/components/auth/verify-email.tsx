"use client";

import { useAuth, useFetchOptions } from "@better-auth-ui/react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "#/components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import { FieldDescription, FieldError } from "#/components/ui/field.tsx";
import { OtpInput, type OtpInputHandle } from "#/components/ui/otp-input.tsx";
import { Spinner } from "#/components/ui/spinner.tsx";
import { safeReturnTo } from "#/domain/return-to";
import { authClient as client } from "#/features/auth/client";
import { cn } from "#/lib/utils.ts";
import { useIsHydrated } from "./use-is-hydrated";

type VerifyEmailProps = {
	className?: string;
};

/** Seconds the resend button stays disabled to prevent spamming the endpoint. */
const RESEND_COOLDOWN_SECONDS = 60;
const CODE_LENGTH = 6;

/** What went wrong, in words, for the codes Better Auth answers with. */
function codeProblem(error: { code?: string; message?: string }) {
	switch (error.code) {
		case "INVALID_OTP":
			return "That code isn't right. Check the email and try again.";
		case "OTP_EXPIRED":
			return "That code has expired. Send a new one.";
		case "TOO_MANY_ATTEMPTS":
			return "Too many tries. Send a new code.";
		default:
			return error.message || "The code could not be checked. Try again.";
	}
}

/**
 * Enter the six-digit code that was emailed. A correct code verifies the
 * address and signs the person in, then the page goes where they were headed.
 *
 * The email is read from `sessionStorage` (set when sign-up or sign-in sends
 * the person here). Resending is Turnstile-protected like sign-in and waits
 * out a cooldown.
 */
export function VerifyEmail({ className }: VerifyEmailProps) {
	const { basePaths, redirectTo, viewPaths, Link, plugins } = useAuth();
	const { fetchOptions, resetFetchOptions } = useFetchOptions();
	const Captcha = plugins.find(
		(plugin) => plugin.captchaComponent,
	)?.captchaComponent;

	const isHydrated = useIsHydrated();
	const [email, setEmail] = useState(
		(isHydrated && sessionStorage.getItem("better-auth-ui.verify-email")) || "",
	);
	const [code, setCode] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [sending, setSending] = useState(false);
	const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
	const otp = useRef<OtpInputHandle>(null);

	useEffect(() => {
		setEmail(sessionStorage.getItem("better-auth-ui.verify-email") ?? "");
	}, []);

	useEffect(() => {
		if (cooldown <= 0 || !email) return;
		const interval = setInterval(() => {
			setCooldown((current) => (current > 0 ? current - 1 : 0));
		}, 1000);
		return () => clearInterval(interval);
	}, [cooldown, email]);

	async function verify(value: string) {
		if (!email || value.length !== CODE_LENGTH || checking) return;
		setChecking(true);
		setError(null);
		const result = await client.emailOtp.verifyEmail({ email, otp: value });
		if (result.error) {
			setError(codeProblem(result.error));
			setCode("");
			setChecking(false);
			// After the boxes are enabled again.
			requestAnimationFrame(() => otp.current?.focus());
			return;
		}
		sessionStorage.removeItem("better-auth-ui.verify-email");
		// A full load, so the page starts with the new session.
		window.location.assign(safeReturnTo(redirectTo));
	}

	function change(digits: string) {
		setCode(digits);
		setError(null);
		if (digits.length === CODE_LENGTH) void verify(digits);
	}

	async function resend() {
		if (!email || cooldown > 0 || sending) return;
		setSending(true);
		const result = await client.emailOtp.sendVerificationOtp({
			email,
			type: "email-verification",
			fetchOptions,
		});
		resetFetchOptions();
		setSending(false);
		if (result.error) {
			toast.error(codeProblem(result.error));
			return;
		}
		toast.success("We sent you a new code.");
		setCooldown(RESEND_COOLDOWN_SECONDS);
		setCode("");
		otp.current?.focus();
	}

	return (
		<Card className={cn("w-full max-w-sm", className)}>
			<CardHeader>
				<CardTitle className="text-xl font-semibold">Enter your code</CardTitle>
			</CardHeader>

			<CardContent>
				<div className="flex flex-col gap-4">
					<FieldDescription>
						{email
							? `We sent a 6-digit code to ${email}. Type it here to finish.`
							: "Go back and sign in or sign up, and we will send you a code."}
					</FieldDescription>

					{email && (
						<form
							className="flex flex-col gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								void verify(code);
							}}
						>
							<OtpInput
								handle={otp}
								value={code}
								onChange={change}
								length={CODE_LENGTH}
								label="6-digit code"
								invalid={Boolean(error)}
								disabled={checking}
								autoFocus
							/>
							{error && (
								// FieldError: the page's alert rule greys every plain alert.
								<FieldError className="text-center">{error}</FieldError>
							)}
							<Button
								type="submit"
								disabled={code.length !== CODE_LENGTH || checking}
							>
								{checking && <Spinner />}
								Verify
							</Button>
						</form>
					)}

					{email && Captcha && (
						<div className="flex justify-center">{Captcha}</div>
					)}

					{email && (
						<Button
							type="button"
							variant="ghost"
							disabled={cooldown > 0 || sending}
							onClick={() => void resend()}
						>
							{sending && <Spinner />}
							{cooldown > 0
								? `Send a new code in ${cooldown}s`
								: "Send a new code"}
						</Button>
					)}
				</div>

				<div className="mt-4 flex w-full flex-col items-center gap-3">
					{email && (
						<FieldDescription className="text-center">
							No code? If this address already has an account, we emailed you a
							link to sign in instead.{" "}
							<Link
								href={`${basePaths.auth}/${viewPaths.auth.signIn}`}
								className="underline underline-offset-4"
							>
								Sign in
							</Link>
						</FieldDescription>
					)}
					<FieldDescription className="text-center">
						Wrong address?{" "}
						<Link
							href={`${basePaths.auth}/${viewPaths.auth.signUp}`}
							className="underline underline-offset-4"
						>
							Use a different email
						</Link>
					</FieldDescription>
				</div>
			</CardContent>
		</Card>
	);
}
