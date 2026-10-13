"use client";

import { isReauthenticationSignInURL } from "@better-auth-ui/core";
import { useAuth } from "@better-auth-ui/react";
import { useSyncExternalStore } from "react";
import { Alert, AlertDescription, AlertTitle } from "#/components/ui/alert.tsx";

const subscribeToLocation = () => () => undefined;

function useIsReauthenticationSignIn() {
	return useSyncExternalStore(
		subscribeToLocation,
		() => isReauthenticationSignInURL(new URL(window.location.href)),
		() => false,
	);
}

export function ReauthenticationNotice() {
	const auth = useAuth();
	const isReauthenticationSignIn = useIsReauthenticationSignIn();
	if (!isReauthenticationSignIn) return null;

	return (
		<Alert className="mx-4 w-auto group-data-[size=sm]/card:mx-3">
			<AlertTitle>
				{auth.localization.settings.reauthenticationTitle}
			</AlertTitle>
			<AlertDescription>
				{auth.localization.settings.reauthenticationDescription}
			</AlertDescription>
		</Alert>
	);
}
