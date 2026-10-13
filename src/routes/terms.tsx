import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "../features/legal/legal-page";

export const Route = createFileRoute("/terms")({
	component: () => (
		<LegalPage
			title="Terms of service"
			sections={[
				{
					heading: "The service",
					body: "ytimesy runs coding agents in cloud workspaces connected to your repositories. Agents can be wrong; review their changes before you merge or deploy them.",
				},
				{
					heading: "Your account",
					body: "Keep your sign-in secure. You are responsible for activity in your account and for the repositories, secrets and model credentials you connect.",
				},
				{
					heading: "Acceptable use",
					body: "Do not use workspaces to attack other systems, send spam, mine cryptocurrency, store illegal content, or get around usage limits.",
				},
				{
					heading: "Usage limits",
					body: "Workspaces and agent turns are metered. When an allowance runs out, new work pauses until it is renewed or raised.",
				},
				{
					heading: "Your content",
					body: "You keep ownership of your code and content. You grant us the rights needed to store and process it to provide the service.",
				},
				{
					heading: "Changes and termination",
					body: "We may change or suspend the service or these terms. We may suspend accounts that break these terms.",
				},
			]}
		/>
	),
});
