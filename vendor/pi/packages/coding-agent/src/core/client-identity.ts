import type { ClientIdentity } from "@earendil-works/pi-ai";
import { VERSION } from "../config.ts";
import type { SettingsManager } from "./settings-manager.ts";

/**
 * How REEF's requests identify it to providers: a detailed `User-Agent` carrying REEF's own version.
 *
 * No attribution, ever. Attribution tells the provider that a named third-party CLI agent made the
 * request; REEF runs on the vendored core, ships no telemetry, and has nothing to report to anyone.
 */
export function getClientIdentity(_settingsManager: SettingsManager): ClientIdentity {
	return {
		userAgent: "detailed",
		version: VERSION,
		attribution: null,
	};
}
