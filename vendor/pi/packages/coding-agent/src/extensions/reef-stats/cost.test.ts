import { describe, expect, test } from "vitest";
import { formatCost, summarizeCost } from "./index.ts";

const request = (over: Record<string, unknown> = {}) => ({
	type: "custom",
	customType: "reef-request",
	data: {
		promptTokens: 1655,
		declaredTools: ["script", "wait_for_script"],
		input: 100,
		output: 20,
		cacheRead: 900,
		cacheWrite: 10,
		reasoning: 0,
		cost: 0.002,
		model: "deepseek-v4.1-flash",
		provider: "opencode-go",
		at: 1,
		...over,
	},
});

const task = (over: Record<string, unknown> = {}) => ({
	type: "custom",
	customType: "reef-task",
	data: { turns: 3, usage: { input: 2000, output: 100, cost: 0.004 }, ...over },
});

describe("summarizeCost", () => {
	test("no requests means no summary", () => {
		expect(summarizeCost([])).toBeUndefined();
	});

	test("ignores entries of other types", () => {
		expect(summarizeCost([{ type: "message" }, { type: "custom", customType: "other", data: {} }])).toBeUndefined();
	});

	test("sums requests and computes cache reuse", () => {
		const summary = summarizeCost([request(), request({ input: 50, cacheRead: 1000, cost: 0.001 })]);
		expect(summary?.requests).toBe(2);
		expect(summary?.input).toBe(150);
		expect(summary?.cacheRead).toBe(1900);
		// 1900 / (150 + 1900 + 20)
		expect(summary?.reusePercent).toBeCloseTo(91.79, 1);
	});

	test("reports the last request's shape, not the first", () => {
		const summary = summarizeCost([request(), request({ declaredTools: ["script"], promptTokens: 1600, model: "m2" })]);
		expect(summary?.declaredTools).toEqual(["script"]);
		expect(summary?.promptTokens).toBe(1600);
		expect(summary?.model).toBe("m2");
	});

	test("delegated spend is attributed separately and in the total", () => {
		const summary = summarizeCost([request(), task(), task({ usage: { input: 10, output: 5, cost: 0.001 } })]);
		expect(summary?.tasks).toBe(2);
		expect(summary?.taskTurns).toBe(6);
		expect(summary?.taskInput).toBe(2010);
		expect(summary?.delegatedCost).toBeCloseTo(0.005, 6);
		expect(summary?.total).toBeCloseTo(0.007, 6);
	});

	test("a task entry with no usage never produces NaN", () => {
		const summary = summarizeCost([request(), { type: "custom", customType: "reef-task", data: {} }]);
		expect(Number.isFinite(summary!.delegatedCost)).toBe(true);
		expect(Number.isFinite(summary!.total)).toBe(true);
	});
});

describe("formatCost", () => {
	test("hides the subagent block when nothing was delegated", () => {
		const text = formatCost(summarizeCost([request()])!);
		expect(text).toContain("Cache reuse:");
		expect(text).not.toContain("Subagents:");
	});

	test("shows the subagent block when something was", () => {
		const text = formatCost(summarizeCost([request(), task()])!);
		expect(text).toContain("Subagents:     1 task(s), 3 turn(s)");
		expect(text).toContain("Delegated:");
		expect(text).toContain("Total:");
	});
});
