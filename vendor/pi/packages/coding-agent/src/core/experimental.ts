export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.REEF_EXPERIMENTAL === "1";
}
