import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../features/legal/legal-page";

export const Route = createFileRoute("/privacy")({
	component: () => (
		<LegalPage
			title="Privacy policy"
			sections={[
				{
					heading: "What we collect",
					body: "Your account details (name, email, and the GitHub or Google identity you sign in with), the repositories you connect, the conversations you have with agents, the files and commands in your workspaces, and usage and billing records.",
				},
				{
					heading: "How it is used",
					body: "To run your workspaces and agents, to show you your history, to meter and limit usage, to keep the service secure, and to improve the product through product analytics.",
				},
				{
					heading: "Who processes it",
					body: "Infrastructure providers that host the service and your workspaces (Cloudflare, Supabase, Freestyle), GitHub for repository access, the model providers you choose for agent turns (which receive your prompts and the code an agent reads), and PostHog for product analytics.",
				},
				{
					heading: "Secrets",
					body: "Project secrets and connected-account credentials are encrypted at rest and are only decrypted to run your work.",
				},
				{
					heading: "Retention and deletion",
					body: "Conversations and workspace backups are kept while your account exists. You can delete chats and projects; contact us to delete your account and its data.",
				},
				{
					heading: "Contact",
					body: "Questions about your data: contact the ytimesy team.",
				},
			]}
		/>
	),
});
