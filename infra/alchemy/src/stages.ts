/** The only stages a stack may deploy to; never an Alchemy per-user default. */
export type InfraStage = "development" | "production";

export function cloudflareStage(stage: string | undefined): InfraStage {
	if (stage === "development" || stage === "production") return stage;
	throw new Error(
		`Stage must be development or production (got ${stage ?? "none"}); run through scripts/infra.ts.`,
	);
}
