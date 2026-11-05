import { describe, expect, it } from "vitest";
import { isToolReachable, type ToolReachability } from "./tool-reachability.ts";

const DEFAULTS = ["read", "bash", "edit", "write"] as const;
const ACTIVE = new Set(["read", "bash", "edit", "write"]);

function check(overrides: Partial<ToolReachability> = {}): boolean {
	return isToolReachable({
		name: "read",
		exposure: "direct",
		active: ACTIVE,
		hiddenWhileActive: new Set(),
		allowed: true,
		defaultActive: undefined,
		defaults: DEFAULTS,
		...overrides,
	});
}

describe("script tool reachability", () => {
	it("keeps the default tools callable", () => {
		for (const name of DEFAULTS) expect(check({ name })).toBe(true);
	});

	it("keeps a tool callable when only its declaration was hidden", () => {
		// The REEF loadout hides read/bash/edit/write declarations but must not remove them from scripts.
		const hidden = new Set(DEFAULTS);
		for (const name of DEFAULTS) expect(check({ name, hiddenWhileActive: hidden })).toBe(true);
	});

	it("does not make a registered non-default tool callable", () => {
		// The regression: powershell is registered everywhere, runs only on Windows, and was reaching
		// scripts on macOS where `tools.shell` then failed with "did you mean powershell?".
		expect(check({ name: "powershell" })).toBe(false);
	});

	it("does not make a defaultActive: false tool callable", () => {
		// task/task_output/task_stop must stay behind explicit activation, even inside a script.
		expect(check({ name: "task", defaultActive: false })).toBe(false);
	});

	it("respects the tool allowlist", () => {
		expect(check({ name: "grep", allowed: false, defaults: [...DEFAULTS, "grep"] })).toBe(false);
		expect(check({ name: "grep", allowed: true, defaults: [...DEFAULTS, "grep"] })).toBe(true);
	});

	it("keeps codemode and deferred tools reachable, and drops hidden ones", () => {
		expect(check({ name: "mcp__srv__tool", exposure: "codemode", active: new Set() })).toBe(true);
		expect(check({ name: "later", exposure: "deferred", active: new Set() })).toBe(true);
		expect(check({ name: "gone", exposure: "hidden", active: new Set() })).toBe(false);
	});

	it("treats a callable tool that is active as reachable without being a default", () => {
		expect(check({ name: "grep", active: new Set(["grep"]) })).toBe(true);
	});
});
