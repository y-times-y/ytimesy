export type SocialProviderId = "github" | "google";

export const offeredSocialProviders: readonly SocialProviderId[] = [
	"github",
	"google",
];

/** What the sign-in page may offer, as configured on the server. */
export type IdentityOptions = {
	readonly socialProviders: readonly SocialProviderId[];
	/** Email can be sent, so email sign-up and password reset work. */
	readonly emailDelivery: boolean;
};
