"use client";

import {
	getAuthLinkURL,
	isPasswordCompromisedError,
	validateMatchingValue,
} from "@better-auth-ui/core";
import { useAuth, useResetPassword } from "@better-auth-ui/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card.tsx";
import { FieldDescription, FieldGroup } from "#/components/ui/field.tsx";
import { cn } from "#/lib/utils.ts";
import { passwordLengthError, useAuthForm } from "./auth-form";

type ResetPasswordProps = {
	className?: string;
};

/**
 * Render a password reset form that validates the reset token from the URL, accepts a new password (and optional confirmation), and submits it to the auth client.
 *
 * The component checks for a `token` query parameter on mount and, if missing, shows an error toast and navigates to the sign-in page. It exposes per-field validation messages, toggles for password visibility, and disables inputs while the reset request is pending.
 *
 * @returns The password reset form UI ready to be mounted in the app layout.
 */
export function ResetPassword({ className }: ResetPasswordProps) {
	const {
		authClient,
		basePaths,
		emailAndPassword,
		localization,
		navigate,
		redirectTo,
		viewPaths,
		Link,
	} = useAuth();
	const signInURL = getAuthLinkURL(
		`${basePaths.auth}/${viewPaths.auth.signIn}`,
		redirectTo,
	);

	const { mutateAsync: resetPassword, isPending } = useResetPassword(
		authClient,
		{
			onError: (error) => {
				// The haveIBeenPwned plugin rejects on the password itself, so it
				// belongs against the field rather than in a toast.
				if (isPasswordCompromisedError(error)) {
					setIsCompromised(true);
				}
			},
			onSuccess: () => {
				toast.success(localization.auth.passwordResetSuccess);
				navigate({ to: signInURL });
			},
		},
	);

	const [isCompromised, setIsCompromised] = useState(false);

	useEffect(() => {
		const searchParams = new URLSearchParams(window.location.search);
		const token = searchParams.get("token") as string;

		if (!token) {
			toast.error(localization.auth.invalidResetPasswordToken);
			navigate({ to: signInURL });
		}
	}, [localization.auth.invalidResetPasswordToken, navigate, signInURL]);

	const form = useAuthForm({
		defaultValues: { confirmPassword: "", password: "" },
		onSubmit: async ({ value }) => {
			const searchParams = new URLSearchParams(window.location.search);
			const token = searchParams.get("token") as string;

			if (!token) {
				toast.error(localization.auth.invalidResetPasswordToken);
				navigate({ to: signInURL });
				return;
			}

			try {
				await resetPassword({ token, newPassword: value.password });
			} catch {
				// The mutation reports the error through its configured handler.
			}
		},
	});

	return (
		<Card className={cn("w-full max-w-sm", className)}>
			<CardHeader>
				<CardTitle className="text-xl font-semibold">
					{localization.auth.resetPassword}
				</CardTitle>
			</CardHeader>

			<CardContent>
				<form.AppForm>
					<form.AuthFormRoot>
						<FieldGroup>
							<form.AppField
								name="password"
								validators={{
									onChange: ({ value }) =>
										passwordLengthError(
											value,
											emailAndPassword,
											localization.auth,
										),
								}}
							>
								{(field) => (
									<field.AuthFormPasswordField
										label={localization.auth.password}
										placeholder={localization.auth.newPasswordPlaceholder}
										minLength={emailAndPassword?.minPasswordLength}
										maxLength={emailAndPassword?.maxPasswordLength}
										disabled={isPending}
										error={
											isCompromised
												? localization.auth.passwordCompromised
												: undefined
										}
										onValueChange={() => setIsCompromised(false)}
										showStrength
									/>
								)}
							</form.AppField>

							{emailAndPassword?.confirmPassword && (
								<form.AppField
									name="confirmPassword"
									validators={{
										onChangeListenTo: ["password"],
										onChange: ({ fieldApi, value }) =>
											passwordLengthError(
												value,
												emailAndPassword,
												localization.auth,
											) ??
											validateMatchingValue(
												value,
												fieldApi.form.getFieldValue("password"),
												localization.auth.passwordsDoNotMatch,
											),
									}}
								>
									{(field) => (
										<field.AuthFormPasswordField
											label={localization.auth.confirmPassword}
											placeholder={localization.auth.confirmPasswordPlaceholder}
											minLength={emailAndPassword?.minPasswordLength}
											maxLength={emailAndPassword?.maxPasswordLength}
											disabled={isPending}
										/>
									)}
								</form.AppField>
							)}

							<div className="flex flex-col gap-3">
								<form.AuthFormSubmitButton disabled={isPending}>
									{localization.auth.resetPassword}
								</form.AuthFormSubmitButton>
							</div>
						</FieldGroup>
					</form.AuthFormRoot>
				</form.AppForm>

				<div className="flex flex-col gap-3 items-center w-full mt-4">
					<FieldDescription className="text-center">
						{localization.auth.rememberYourPassword}{" "}
						<Link
							href={getAuthLinkURL(
								`${basePaths.auth}/${viewPaths.auth.signIn}`,
								redirectTo,
							)}
							className="underline underline-offset-4"
						>
							{localization.auth.signIn}
						</Link>
					</FieldDescription>
				</div>
			</CardContent>
		</Card>
	);
}
