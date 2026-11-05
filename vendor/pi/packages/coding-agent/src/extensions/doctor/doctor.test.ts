import { describe, expect, it } from "vitest";
import { type Check, formatChecks } from "./index.ts";

const check = (name: string, ok: boolean | undefined, detail = "x"): Check => ({ name, ok, detail });

describe("formatChecks", () => {
	it("marks each check and counts the failures", () => {
		const text = formatChecks([check("model", true), check("credentials", false)]);
		expect(text).toContain("✓ model");
		expect(text).toContain("! credentials");
		expect(text).toContain("2 checks · 1 failing · 0 unknown");
	});

	it("says so when everything passes", () => {
		expect(formatChecks([check("model", true)])).toContain("All 1 checks passed.");
	});

	it("a check that could not run is unknown, not a pass", () => {
		const text = formatChecks([check("cache contract", undefined, "no request yet")]);
		expect(text).toContain("? cache contract");
		expect(text).toContain("1 unknown");
	});
});
