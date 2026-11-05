import { describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildPrompt, capReturn, independentModel, MAX_RETURN_TOKENS, modelFamily, summarizeEvents } from "./child.ts";
import { BUILTIN_AGENTS, FORBIDDEN_CHILD_TOOLS, loadDefinitions, parseDefinition, splitFrontmatter, toolsFor } from "./definitions.ts";

const valid = `---
name: reviewer
description: Reviews a diff
tools: read-only
---

You review diffs.`;

describe("frontmatter", () => {
	test("splits fields from body", () => {
		const split = splitFrontmatter(valid);
		expect(split?.fields.name).toBe("reviewer");
		expect(split?.body).toBe("You review diffs.");
	});

	test("a file without frontmatter is not a definition", () => {
		expect(splitFrontmatter("just prose")).toBeUndefined();
	});

	test("an unterminated block is not a definition", () => {
		expect(splitFrontmatter("---\nname: x\n")).toBeUndefined();
	});
});

describe("parseDefinition", () => {
	test("accepts a well-formed definition", () => {
		const { definition, problems } = parseDefinition(valid, "/x/reviewer.md");
		expect(problems).toEqual([]);
		expect(definition?.name).toBe("reviewer");
		expect(definition?.tools.kind).toBe("read-only");
	});

	test("the filename is the name when `name` is missing", () => {
		const { definition } = parseDefinition(`---\ndescription: d\n---\nbody`, "/x/scout.md");
		expect(definition?.name).toBe("scout");
	});

	test("rejects a missing description", () => {
		const { problems } = parseDefinition(`---\nname: a\n---\nbody`, "/x/a.md");
		expect(problems.map((p) => p.message)).toContain("missing `description`");
	});

	test("rejects an empty body, because the body is the prompt", () => {
		const { problems } = parseDefinition(`---\nname: a\ndescription: d\n---\n   `, "/x/a.md");
		expect(problems.map((p) => p.message)).toContain("the body is empty: that is the prompt");
	});

	test("rejects unknown fields rather than ignoring them", () => {
		const { problems } = parseDefinition(`---\nname: a\ndescription: d\ntoolz: bash\n---\nbody`, "/x/a.md");
		expect(problems.map((p) => p.message)).toContain("unknown field `toolz`");
	});

	test("rejects a malformed name", () => {
		const { problems } = parseDefinition(`---\nname: Reviewer Bot\ndescription: d\n---\nbody`, "/x/a.md");
		expect(problems.some((p) => p.message.includes("must match"))).toBe(true);
	});

	test("accepts a category or an explicit list", () => {
		expect(parseDefinition(`---\nname: a\ndescription: d\ntools: execute\n---\nb`, "/a.md").definition?.tools.kind).toBe("execute");
		const explicit = parseDefinition(`---\nname: a\ndescription: d\ntools: [read, grep]\n---\nb`, "/a.md");
		expect(explicit.definition?.tools.explicit).toEqual(["read", "grep"]);
	});

	test("rejects an empty tools list", () => {
		const { problems } = parseDefinition(`---\nname: a\ndescription: d\ntools: []\n---\nb`, "/a.md");
		expect(problems.some((p) => p.message.includes("must be a category or a list"))).toBe(true);
	});

	test("model must be inherit, a tier, or a model id", () => {
		expect(parseDefinition(`---\nname: a\ndescription: d\nmodel: inherit\n---\nb`, "/a.md").definition?.model).toBe("inherit");
		expect(parseDefinition(`---\nname: a\ndescription: d\nmodel: heavy\n---\nb`, "/a.md").definition?.model).toBe("heavy");
		expect(parseDefinition(`---\nname: a\ndescription: d\nmodel: openai/gpt-5\n---\nb`, "/a.md").definition?.model).toBe("openai/gpt-5");
	});
});

describe("child tool policy", () => {
	test("a child never gets the delegation tools, whatever it asks for", () => {
		const { definition } = parseDefinition(`---\nname: a\ndescription: d\ntools: [read, task, task_output]\n---\nb`, "/a.md");
		const granted = toolsFor(definition!);
		expect(granted).toEqual(["read"]);
		for (const forbidden of FORBIDDEN_CHILD_TOOLS) expect(granted).not.toContain(forbidden);
	});

	test("the built-ins are read-only or execute, never delegating", () => {
		for (const agent of BUILTIN_AGENTS) {
			const granted = toolsFor(agent);
			expect(granted).not.toContain("task");
			expect(granted.length).toBeGreaterThan(0);
		}
	});

	test("every built-in parses as a valid definition", () => {
		for (const agent of BUILTIN_AGENTS) {
			expect(agent.description.length).toBeGreaterThan(0);
			expect(agent.body.length).toBeGreaterThan(0);
		}
	});
});

describe("loadDefinitions", () => {
	test("project definitions replace personal ones of the same name", () => {
		const home = mkdtempSync(join(tmpdir(), "reef-home-"));
		const cwd = mkdtempSync(join(tmpdir(), "reef-proj-"));
		mkdirSync(join(home, "agents"), { recursive: true });
		mkdirSync(join(cwd, ".reef", "agents"), { recursive: true });
		writeFileSync(join(home, "agents", "reviewer.md"), `---\nname: reviewer\ndescription: personal\n---\npersonal body`);
		writeFileSync(join(cwd, ".reef", "agents", "reviewer.md"), `---\nname: reviewer\ndescription: project\n---\nproject body`);

		const loaded = loadDefinitions(cwd, home);
		expect(loaded.definitions).toHaveLength(1);
		expect(loaded.definitions[0]?.description).toBe("project");
		expect(loaded.definitions[0]?.body).toBe("project body");
	});

	test("a missing directory is empty, not an error", () => {
		const cwd = mkdtempSync(join(tmpdir(), "reef-empty-"));
		const loaded = loadDefinitions(cwd, join(cwd, "nope"));
		expect(loaded.definitions).toEqual([]);
		expect(loaded.problems).toEqual([]);
	});

	test("one broken definition does not hide the others", () => {
		const cwd = mkdtempSync(join(tmpdir(), "reef-mixed-"));
		mkdirSync(join(cwd, ".reef", "agents"), { recursive: true });
		writeFileSync(join(cwd, ".reef", "agents", "good.md"), `---\nname: good\ndescription: d\n---\nbody`);
		writeFileSync(join(cwd, ".reef", "agents", "bad.md"), `---\nname: bad\n---\nbody`);
		const loaded = loadDefinitions(cwd, join(cwd, "nope"));
		expect(loaded.definitions.map((d) => d.name)).toEqual(["good"]);
		expect(loaded.problems).toHaveLength(1);
	});
});

describe("child prompt", () => {
	const explorer = BUILTIN_AGENTS[0]!;

	test("carries the definition body and the specification, and no parent transcript", () => {
		const prompt = buildChildPrompt(explorer, {
			prompt: "Where is the session writer?",
			context: "It is under src/core.",
			constraints: ["Do not read test fixtures"],
			done_when: ["A path is named"],
		});
		expect(prompt).toContain("You are an explorer");
		expect(prompt).toContain("<delegation>");
		expect(prompt).toContain("Where is the session writer?");
		expect(prompt).toContain("<context>");
		expect(prompt).toContain("Do not read test fixtures");
		expect(prompt).toContain("Done when:");
	});

	test("asks for one message and caps the return", () => {
		const prompt = buildChildPrompt(explorer, { prompt: "x" });
		expect(prompt).toContain(`under ${MAX_RETURN_TOKENS} tokens`);
		expect(prompt).toContain("Return exactly one message");
	});

	test("json return format is stated", () => {
		expect(buildChildPrompt(explorer, { prompt: "x", return_format: "json" })).toContain("must be valid JSON");
	});
});

describe("capReturn", () => {
	test("leaves a short message alone", () => {
		expect(capReturn("  short  ")).toBe("short");
	});

	test("truncates a long message with a marker", () => {
		const capped = capReturn("x".repeat(MAX_RETURN_TOKENS * 4 + 10));
		expect(capped).toContain(`[truncated at ${MAX_RETURN_TOKENS} tokens]`);
	});
});

describe("summarizeEvents", () => {
	const line = (event: unknown) => JSON.stringify(event);

	test("takes the last assistant text and sums usage", () => {
		const summary = summarizeEvents([
			line({ type: "turn_start" }),
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
			line({ type: "turn_start" }),
			line({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "  final answer  " }],
					usage: { input: 100, output: 20, cacheRead: 40, cacheWrite: 5, cost: { total: 0.002 } },
				},
			}),
		]);
		expect(summary.message).toBe("final answer");
		expect(summary.turns).toBe(2);
		expect(summary.usage).toEqual({ input: 100, output: 20, cacheRead: 40, cacheWrite: 5, cost: 0.002 });
	});

	test("ignores user messages and non-json lines", () => {
		const summary = summarizeEvents([
			"not json",
			line({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
		]);
		expect(summary.message).toBe("");
		expect(summary.usage.cost).toBe(0);
	});

	test("a scalar cost is accepted too", () => {
		const summary = summarizeEvents([
			line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }], usage: { cost: 0.5 } } }),
		]);
		expect(summary.usage.cost).toBe(0.5);
	});

	test("missing and malformed usage fields never produce NaN", () => {
		const summary = summarizeEvents([
			line({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "a" }], usage: { input: "nope", cost: { total: undefined } } },
			}),
		]);
		expect(Number.isFinite(summary.usage.input)).toBe(true);
		expect(Number.isFinite(summary.usage.cost)).toBe(true);
	});
});

describe("independentFamily", () => {
	test("the family is the first segment of the id", () => {
		expect(modelFamily("claude-haiku-5-5")).toBe("claude");
		expect(modelFamily("deepseek-v4.1-flash")).toBe("deepseek");
		expect(modelFamily("gpt-6-luna")).toBe("gpt");
	});

	test("picks a different family, and prefers a full model over a small one", () => {
		const chosen = independentModel("deepseek-v4.1-flash", [
			{ provider: "p", id: "deepseek-v4-pro" },
			{ provider: "p", id: "gpt-5.6-luna-flash" },
			{ provider: "p", id: "gpt-6-luna" },
		]);
		expect(chosen?.id).toBe("gpt-6-luna");
	});

	test("returns nothing when every model shares the family", () => {
		expect(independentModel("deepseek-v4.1-flash", [{ provider: "p", id: "deepseek-v4-pro" }])).toBeUndefined();
	});

	test("the reviewer asks for an independent family", () => {
		expect(BUILTIN_AGENTS.find((a) => a.name === "reviewer")?.model).toBe("different");
	});
});
