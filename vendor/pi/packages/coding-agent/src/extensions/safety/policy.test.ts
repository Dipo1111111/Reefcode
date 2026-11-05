import { describe, expect, it } from "vitest";
import { loadPolicy, PRECEDENCE, policyPaths, resolveCommand, validatePolicyDocument } from "./policy.ts";

const valid = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	rules: [
		{
			id: "no-install",
			decision: "block",
			reason: "Use npm ci.",
			match: { prefix: ["npm", "install"] },
			tests: { match: ["npm install", "npm install left-pad"], noMatch: ["npm ci"] },
			...overrides,
		},
	],
});

describe("validation", () => {
	it("accepts a well-formed file", () => {
		const result = validatePolicyDocument(valid(), "test", 20);
		expect(result.problems).toEqual([]);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].precedence).toBe(20);
	});

	it("rejects unknown fields instead of ignoring them", () => {
		const result = validatePolicyDocument({ ...valid(), extra: true }, "test", 20);
		expect(result.problems.join()).toContain("unknown field `extra`");
	});

	it("rejects an unknown match field", () => {
		const doc = {
			rules: [{ id: "a", decision: "block", reason: "x", match: { prefix: ["ls"], preffix: ["cat"] }, tests: { match: ["ls"], noMatch: ["cat"] } }],
		};
		expect(validatePolicyDocument(doc, "test", 20).problems.join()).toContain("unknown match field `preffix`");
	});

	it("reserves the builtin/ prefix", () => {
		const doc = { rules: [{ id: "builtin/x", decision: "allow", reason: "x", match: { prefix: ["ls"] }, tests: { match: ["ls"], noMatch: ["cat"] } }] };
		expect(validatePolicyDocument(doc, "test", 20).problems.join()).toContain("`builtin/` is reserved");
	});

	it("requires tests, and enforces them", () => {
		const noTests = { rules: [{ id: "a", decision: "block", reason: "x", match: { prefix: ["ls"] } }] };
		expect(validatePolicyDocument(noTests, "test", 20).problems.join()).toContain("`tests` must carry");

		const liar = {
			rules: [{ id: "a", decision: "block", reason: "x", match: { prefix: ["git", "log"] }, tests: { match: ["git status"], noMatch: ["git log"] } }],
		};
		const problems = validatePolicyDocument(liar, "test", 20).problems.join();
		expect(problems).toContain("does not match its own example `git status`");
		expect(problems).toContain("matches its own `noMatch` example `git log`");
	});

	it("requires a reason", () => {
		const doc = { rules: [{ id: "a", decision: "block", match: { prefix: ["ls"] }, tests: { match: ["ls"], noMatch: ["cat"] } }] };
		expect(validatePolicyDocument(doc, "test", 20).problems.join()).toContain("missing `reason`");
	});

	it("rejects a duplicate id in one file", () => {
		const doc = {
			rules: [
				{ id: "a", decision: "allow", reason: "x", match: { prefix: ["ls"] }, tests: { match: ["ls"], noMatch: ["cat"] } },
				{ id: "a", decision: "block", reason: "x", match: { prefix: ["cat"] }, tests: { match: ["cat"], noMatch: ["ls"] } },
			],
		};
		expect(validatePolicyDocument(doc, "test", 20).problems.join()).toContain("duplicate id `a`");
	});

	it("rejects a broken regex", () => {
		const doc = { rules: [{ id: "a", decision: "block", reason: "x", match: { regex: "([" }, tests: { match: ["x"], noMatch: ["y"] } }] };
		expect(validatePolicyDocument(doc, "test", 20).problems.join()).toContain("not a valid regular expression");
	});

	it("rejects a bad version", () => {
		expect(validatePolicyDocument({ version: 2, rules: [] }, "test", 20).problems.join()).toContain("unsupported version");
	});
});

describe("loading", () => {
	const files = new Map<string, string>([
		["/home/.reef/agent/permissions.json", JSON.stringify(valid({ id: "user-rule" }))],
		["/work/project/package.json", "{}"],
		[
			"/work/project/.reef/permissions.json",
			JSON.stringify({ rules: [{ id: "project-rule", decision: "allow", reason: "x", match: { prefix: ["make"] }, tests: { match: ["make test"], noMatch: ["ls"] } }] }),
		],
	]);
	const read = (path: string) => files.get(path);

	it("finds the user file and the project file", () => {
		const policy = loadPolicy({ cwd: "/work/project", agentDir: "/home/.reef/agent", readFile: read });
		const ids = policy.rules.map((rule) => rule.id);
		expect(ids).toContain("user-rule");
		expect(ids).toContain("project-rule");
		expect(policy.problems).toEqual([]);
		expect(policy.sources).toHaveLength(2);
	});

	it("orders project above user", () => {
		const policy = loadPolicy({ cwd: "/work/project", agentDir: "/home/.reef/agent", readFile: read });
		const user = policy.rules.find((rule) => rule.id === "user-rule");
		const project = policy.rules.find((rule) => rule.id === "project-rule");
		expect(project?.precedence).toBeGreaterThan(user?.precedence ?? 0);
	});

	it("surfaces a broken file as a problem, not a crash", () => {
		const broken = (path: string) => (path.endsWith("permissions.json") ? "{ not json" : undefined);
		const policy = loadPolicy({ cwd: "/work/project", agentDir: "/home/.reef/agent", readFile: broken });
		expect(policy.problems.join()).toContain("not valid JSON");
	});

	it("walks up to the project root", () => {
		const paths = policyPaths("/work/project/src/deep/tree", "/home/.reef/agent");
		expect(paths.some((entry) => entry.path === "/work/project/.reef/permissions.json")).toBe(true);
		expect(paths[paths.length - 1].path).toBe("/work/project/src/deep/tree/.reef/permissions.local.json");
	});
});

describe("resolution", () => {
	const rules = [
		...validatePolicyDocument(valid({ id: "user-no-install" }), "user", PRECEDENCE.user).rules,
		...validatePolicyDocument(
			{ rules: [{ id: "project-allow-install", decision: "allow", reason: "x", match: { prefix: ["npm", "install"] }, tests: { match: ["npm install"], noMatch: ["npm ci"] } }] },
			"project",
			PRECEDENCE.project,
		).rules,
	];

	it("lets the higher precedence decide", () => {
		const resolution = resolveCommand("npm install left-pad", rules);
		expect(resolution?.decision).toBe("allow");
		expect(resolution?.rule?.id).toBe("project-allow-install");
		expect(resolution?.competing.map((rule) => rule.id)).toEqual(["project-allow-install", "user-no-install"]);
	});

	it("prefers block over allow at equal precedence", () => {
		const same = [
			...validatePolicyDocument({ rules: [{ id: "a-allow", decision: "allow", reason: "x", match: { prefix: ["ls"] }, tests: { match: ["ls"], noMatch: ["cat"] } }] }, "p", 20).rules,
			...validatePolicyDocument({ rules: [{ id: "b-block", decision: "block", reason: "x", match: { prefix: ["ls"] }, tests: { match: ["ls"], noMatch: ["cat"] } }] }, "p", 20).rules,
		];
		expect(resolveCommand("ls -la", same)?.decision).toBe("block");
	});

	it("returns nothing when no rule matches", () => {
		expect(resolveCommand("echo hi", rules)).toBeUndefined();
	});

	it("sees through a wrapper", () => {
		const builtin = loadPolicy({ cwd: "/nonexistent", agentDir: "/nonexistent", readFile: () => undefined }).rules;
		expect(resolveCommand("sudo rm -rf /", builtin)?.decision).toBe("block");
		expect(resolveCommand("bash -lc 'rm -rf /'", builtin)?.decision).toBe("block");
	});
});

describe("disabled rules", () => {
	it("still shadow a lower-precedence rule with the same id", () => {
		const files = new Map<string, string>([
			["/home/.reef/agent/permissions.json", JSON.stringify({ rules: [{ id: "same", decision: "block", reason: "user", match: { prefix: ["make"] }, tests: { match: ["make"], noMatch: ["ls"] } }] })],
			["/work/project/.reef/permissions.json", JSON.stringify({ rules: [{ id: "same", decision: "allow", reason: "project", match: { prefix: ["make"] }, tests: { match: ["make"], noMatch: ["ls"] }, enabled: false }] })],
			["/work/project/package.json", "{}"],
		]);
		const policy = loadPolicy({ cwd: "/work/project", agentDir: "/home/.reef/agent", readFile: (path) => files.get(path) });
		expect(policy.rules.some((rule) => rule.id === "same" && rule.precedence === PRECEDENCE.user)).toBe(false);
	});
});
