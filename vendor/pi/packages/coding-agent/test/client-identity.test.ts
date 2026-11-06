import { describe, expect, it } from "vitest";
import { getClientIdentity } from "../src/core/client-identity.ts";
import { SETTINGS_DEFAULTS } from "../src/core/settings-defaults.ts";
import type { SettingsManager } from "../src/core/settings-manager.ts";

const settingsManager = { getEnableInstallTelemetry: () => true } as unknown as SettingsManager;

describe("getClientIdentity", () => {
	it("never attributes requests to another CLI agent, even with telemetry on", () => {
		expect(getClientIdentity(settingsManager).attribution).toBeNull();
	});

	it("identifies itself by REEF's own version", () => {
		expect(getClientIdentity(settingsManager).version).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("ships with install telemetry off", () => {
		expect(SETTINGS_DEFAULTS.enableInstallTelemetry).toBe(false);
	});
});
