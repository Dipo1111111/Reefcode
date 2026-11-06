import { describe, expect, it } from "vitest";
import { applySectionBudgets, estimateTokens, orderSections, RequestAuditor, SECTION_BUDGETS } from "./request-audit.ts";

const sections = (overrides: Record<string, string> = {}) => ({
	preamble: "You are REEF.",
	tools: "- script: run a script",
	rules: "- Be concise",
	cwd: "/work/project",
	...overrides,
});

describe("section budgets", () => {
	it("leaves a normal prompt alone", () => {
		const result = applySectionBudgets(sections());
		expect(result.truncated).toEqual([]);
		expect(result.sections.preamble).toBe("You are REEF.");
	});

	it("truncates project context from the middle and says so", () => {
		const big = "head\n".repeat(6000) + "tail";
		const result = applySectionBudgets(sections({ project_context: big }));
		expect(result.truncated.map((entry) => entry.name)).toEqual(["project_context"]);
		expect(result.sections.project_context).toContain("omitted to fit its budget");
		expect(result.sections.project_context).toContain("head");
		expect(estimateTokens(result.sections.project_context)).toBeLessThanOrEqual(SECTION_BUDGETS.project_context.cap * 1.2);
	});

	it("keeps skill names when the index is too big", () => {
		const skills = Array.from({ length: 400 }, (_, index) => `- skill-${index}: does a thing worth describing at length`).join("\n");
		const result = applySectionBudgets(sections({ skills }));
		expect(result.truncated.map((entry) => entry.name)).toEqual(["skills"]);
		expect(result.sections.skills).toContain("skill-0");
		expect(result.sections.skills).toContain("searchTools");
	});

	it("never truncates the cwd", () => {
		const result = applySectionBudgets(sections({ cwd: "/".padEnd(400, "x") }));
		expect(result.sections.cwd).toHaveLength(400);
	});
});

describe("volatility ordering", () => {
	it("puts the most volatile section last", () => {
		const ordered = Object.keys(orderSections({ skills: "s", preamble: "p", rules: "r", project_context: "c", tools: "t" }));
		expect(ordered).toEqual(["preamble", "tools", "rules", "project_context", "skills"]);
	});

	it("keeps unknown sections after known ones", () => {
		expect(Object.keys(orderSections({ custom: "x", preamble: "p" }))).toEqual(["preamble", "custom"]);
	});
});

describe("the cache contract", () => {
	it("marks the first request as such", () => {
		const auditor = new RequestAuditor();
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages: [{ role: "user", content: "hi" }] });
		expect(audit.breakReason).toBe("first_request");
		expect(audit.appendOnly).toBe(true);
		expect(audit.request).toBe(1);
	});

	it("accepts an appended message", () => {
		const auditor = new RequestAuditor();
		const messages: { role: string; content: string }[] = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		messages.push({ role: "assistant", content: "hello" });
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages });
		expect(audit.appendOnly).toBe(true);
	});

	it("catches an edited message", () => {
		const auditor = new RequestAuditor();
		const messages: { role: string; content: string }[] = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		messages[0] = { role: "user", content: "hi, but shorter" };
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages });
		expect(audit.appendOnly).toBe(false);
		expect(audit.violations[0]).toContain("message 0 changed");
	});

	it("ignores the cache_control markers a provider adds on the way out", () => {
		// Regression: adapters annotate the last block in place, the hash changed, and the audit wrote
		// "message 0 changed after it was sent" over the input box for a request that never changed.
		const auditor = new RequestAuditor();
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] as { type: string; text: string; cache_control?: unknown }[] },
		];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		messages[0]!.content[0]!.cache_control = { type: "ephemeral" };
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages });
		expect(audit.appendOnly).toBe(true);
	});

	it("catches a section edit mid-session", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		const audit = auditor.observe({ sections: sections({ preamble: "You are REEF today." }), tools: ["script"], messages });
		expect(audit.appendOnly).toBe(false);
		expect(audit.violations.join()).toContain("section `preamble` changed");
	});

	it("catches a removed tool declaration", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script", "wait_for_script"], messages });
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages });
		expect(audit.appendOnly).toBe(false);
		expect(audit.violations.join()).toContain("tool declarations changed shape");
	});

	it("accepts an appended tool declaration", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		const audit = auditor.observe({ sections: sections(), tools: ["script", "read"], messages });
		expect(audit.appendOnly).toBe(true);
	});

	it("does not complain when the break is declared", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		messages[0] = { role: "user", content: "rewritten by compaction" };
		const audit = auditor.observe({ sections: sections(), tools: ["script"], messages, breakReason: "compaction" });
		expect(audit.appendOnly).toBe(true);
		expect(audit.breakReason).toBe("compaction");
	});

	it("names the section that grew", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		const withContext = sections({ project_context: "short" });
		auditor.observe({ sections: withContext, tools: ["script"], messages });
		const audit = auditor.observe({
			sections: sections({ project_context: "much longer than before" }),
			tools: ["script"],
			messages,
		});
		expect(audit.violations.join()).toContain("section `project_context` changed");
	});

	it("allows a new section appended at the tail", () => {
		const auditor = new RequestAuditor();
		const messages = [{ role: "user", content: "hi" }];
		auditor.observe({ sections: sections(), tools: ["script"], messages });
		const audit = auditor.observe({
			sections: sections({ jobs: "job-1 running" }),
			tools: ["script"],
			messages,
		});
		expect(audit.appendOnly).toBe(true);
	});

	it("keeps a bounded history", () => {
		const auditor = new RequestAuditor();
		const messages: { role: string; content: string }[] = [];
		for (let index = 0; index < 210; index += 1) {
			messages.push({ role: "user", content: `m${index}` });
			auditor.observe({ sections: sections(), tools: ["script"], messages });
		}
		expect(auditor.history.length).toBe(200);
		expect(auditor.history[199].request).toBe(210);
	});
});
