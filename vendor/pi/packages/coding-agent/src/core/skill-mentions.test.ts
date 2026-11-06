import { describe, expect, it } from "vitest";
import { expandSkillMentions, renderSkillBlock, type SkillMention } from "./skill-mentions.ts";

const remember: SkillMention = {
	name: "remember",
	filePath: "/skills/remember/SKILL.md",
	baseDir: "/skills/remember",
	body: "# Remember\n\nStep 1. Read the file.\nStep 2. Write the file.",
};
const design: SkillMention = { ...remember, name: "design-taste-frontend" };
const known = new Map([remember, design].map((skill) => [skill.name, skill]));
const resolve = (name: string) => known.get(name);
const builtins = new Set(["model", "settings", "export"]);

describe("expandSkillMentions", () => {
	it("expands skill:name", () => {
		const out = expandSkillMentions("skill:remember save this", resolve, builtins);
		expect(out).toContain('<skill name="remember"');
		expect(out).toContain("Step 1. Read the file.");
		expect(out.endsWith("save this")).toBe(true);
	});

	it("expands the legacy /skill:name spelling", () => {
		const out = expandSkillMentions("/skill:remember save this", resolve, builtins);
		expect(out).toContain('<skill name="remember"');
		expect(out.endsWith("save this")).toBe(true);
	});

	it("expands a typed /name", () => {
		const out = expandSkillMentions("/remember save this", resolve, builtins);
		expect(out).toContain('<skill name="remember"');
		expect(out).toContain("save this");
	});

	it("expands a slash mention mid-message", () => {
		const out = expandSkillMentions("please /remember this session", resolve, builtins);
		expect(out).toContain('<skill name="remember"');
		expect(out).toContain("please this session");
	});

	it("leaves a leading built-in command alone", () => {
		expect(expandSkillMentions("/model fast", resolve, builtins)).toBe("/model fast");
		expect(expandSkillMentions("/settings", resolve, builtins)).toBe("/settings");
	});

	it("expands a skill whose name collides with a built-in when it is not leading", () => {
		const withModel = new Map(known).set("model", { ...remember, name: "model" });
		const out = expandSkillMentions("use /model here", (n) => withModel.get(n), builtins);
		expect(out).toContain('<skill name="model"');
	});

	it("keeps every block when a message names several skills", () => {
		const out = expandSkillMentions("/remember and skill:design-taste-frontend then go", resolve, builtins);
		expect(out.match(/<skill name=/g)?.length).toBe(2);
	});

	it("leaves unknown names as typed", () => {
		expect(expandSkillMentions("/nope do a thing", resolve, builtins)).toBe("/nope do a thing");
	});

	it("does not touch paths and ordinary prose", () => {
		const text = "read src/index.ts and /usr/local/bin, then report at /tmp";
		expect(expandSkillMentions(text, resolve, builtins)).toBe(text);
	});

	it("carries the batching directive and the reference base into every block", () => {
		const out = expandSkillMentions("/remember go", resolve, builtins);
		expect(out).toContain("Run this procedure in as few turns as possible");
		expect(out).toContain("References are relative to /skills/remember.");
	});

	it("expands exactly once, even when the skill body names itself", () => {
		// The remember skill's instructions say `/remember save` and `/remember restore`. A second pass
		// over expanded text inserted the skill again for each mention, nine times, breaking the block
		// parser so the whole thing rendered as one user message.
		const selfNaming: SkillMention = {
			...remember,
			body: "# Remember\n\nEvery session ends with `/remember save`.\nEvery session starts with `/remember restore`.",
		};
		const once = expandSkillMentions("/remember restore the ios folder", (n) => (n === "remember" ? selfNaming : undefined), builtins);
		expect(once.match(/<skill name=/g)?.length).toBe(1);
		expect(expandSkillMentions(once, (n) => (n === "remember" ? selfNaming : undefined), builtins)).toBe(once);
	});

	it("renders one block from a skill without re-reading its file", () => {
		expect(renderSkillBlock(remember)).toContain("Step 2. Write the file.");
	});
});
