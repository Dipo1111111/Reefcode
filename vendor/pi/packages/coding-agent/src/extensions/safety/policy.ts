/**
 * Permissions files: reading them, refusing bad ones, and resolving who wins.
 *
 * `docs/07` §2.3 fixes the precedence: `builtin → user → project → folder(nested) → local →
 * enterprise`. Later wins. At equal precedence `block` beats `ask` beats `allow`, and a `block` from
 * enterprise cannot be overridden by anything.
 *
 * Validation fails closed. Unknown fields are errors, not ignored, because a typo in a permission
 * file that silently does nothing is worse than a startup error.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BUILTIN_RULES, type BuiltinRule, type Decision, type RuleMatch, ruleMatches } from "./rules.ts";

export interface PolicyRule extends BuiltinRule {
	/** Where the rule came from, for `/safety` and `permissions list`. */
	source: string;
	/** Higher wins. See `PRECEDENCE`. */
	precedence: number;
}

export const PRECEDENCE = {
	builtin: 0,
	user: 10,
	project: 20,
	local: 30,
	enterprise: 40,
} as const;

const DECISION_RANK: Record<Decision, number> = { allow: 1, ask: 2, block: 3 };

const TOP_LEVEL_FIELDS = new Set(["version", "rules"]);
const RULE_FIELDS = new Set(["id", "decision", "reason", "match", "tests", "enabled"]);
const MATCH_FIELDS = new Set(["prefix", "anyToken", "regex"]);

export interface ValidationResult {
	rules: PolicyRule[];
	problems: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, allowed: Set<string>): string[] {
	return Object.keys(value).filter((key) => !allowed.has(key));
}

/** Validate one parsed permissions document. Problems are fatal; nothing half-loaded is returned. */
export function validatePolicyDocument(raw: unknown, source: string, precedence: number): ValidationResult {
	const problems: string[] = [];
	const rules: PolicyRule[] = [];

	if (!isRecord(raw)) {
		return { rules, problems: [`${source}: expected an object with a \`rules\` array`] };
	}
	for (const field of unknownFields(raw, TOP_LEVEL_FIELDS)) problems.push(`${source}: unknown field \`${field}\``);
	if (raw.version !== undefined && raw.version !== 1) problems.push(`${source}: unsupported version ${String(raw.version)}`);
	if (!Array.isArray(raw.rules)) {
		problems.push(`${source}: \`rules\` must be an array`);
		return { rules, problems };
	}

	const seen = new Set<string>();
	raw.rules.forEach((entry, index) => {
		const where = `${source}: rule ${index}`;
		if (!isRecord(entry)) {
			problems.push(`${where}: expected an object`);
			return;
		}
		for (const field of unknownFields(entry, RULE_FIELDS)) problems.push(`${where}: unknown field \`${field}\``);
		const id = typeof entry.id === "string" ? entry.id : undefined;
		if (!id) {
			problems.push(`${where}: missing \`id\``);
			return;
		}
		if (id.startsWith("builtin/")) {
			problems.push(`${where}: \`builtin/\` is reserved`);
			return;
		}
		if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
			problems.push(`${where}: id \`${id}\` must be letters, digits, dot, dash, underscore`);
			return;
		}
		if (seen.has(id)) problems.push(`${where}: duplicate id \`${id}\``);
		seen.add(id);

		const decision = entry.decision;
		if (decision !== "allow" && decision !== "ask" && decision !== "block") {
			problems.push(`${where}: \`decision\` must be allow, ask, or block`);
			return;
		}
		const reason = typeof entry.reason === "string" && entry.reason.trim() ? entry.reason.trim() : undefined;
		if (!reason) problems.push(`${where}: missing \`reason\` — a decision without a reason cannot be explained`);

		if (!isRecord(entry.match)) {
			problems.push(`${where}: missing \`match\``);
			return;
		}
		for (const field of unknownFields(entry.match, MATCH_FIELDS)) problems.push(`${where}: unknown match field \`${field}\``);
		const match = entry.match as RuleMatch;
		if (!match.prefix && !match.anyToken && !match.regex) problems.push(`${where}: \`match\` needs one of prefix, anyToken, regex`);
		if (match.regex !== undefined) {
			try {
				new RegExp(match.regex);
			} catch {
				problems.push(`${where}: \`match.regex\` is not a valid regular expression`);
				return;
			}
		}

		const tests = entry.tests;
		if (!isRecord(tests) || !Array.isArray(tests.match) || !Array.isArray(tests.noMatch)) {
			problems.push(`${where}: \`tests\` must carry \`match\` and \`noMatch\` example arrays`);
			return;
		}
		if (tests.match.length === 0) problems.push(`${where}: \`tests.match\` needs at least one example`);
		if (tests.noMatch.length === 0) problems.push(`${where}: \`tests.noMatch\` needs at least one example`);

		const rule: PolicyRule = {
			id,
			decision,
			reason: reason ?? id,
			match,
			tests: {
				match: tests.match.filter((value: unknown): value is string => typeof value === "string"),
				noMatch: tests.noMatch.filter((value: unknown): value is string => typeof value === "string"),
			},
			enabled: entry.enabled !== false,
			source,
			precedence,
		};

		// A rule that fails its own examples is inert. That is a problem, not a warning.
		for (const example of rule.tests.match) {
			if (!ruleMatches(rule, example)) problems.push(`${where}: does not match its own example \`${example}\``);
		}
		for (const example of rule.tests.noMatch) {
			if (ruleMatches(rule, example)) problems.push(`${where}: matches its own \`noMatch\` example \`${example}\``);
		}
		rules.push(rule);
	});

	return { rules, problems };
}

export interface LoadedPolicy {
	rules: PolicyRule[];
	problems: string[];
	/** Files that were read, in precedence order. */
	sources: string[];
}

export interface LoadPolicyOptions {
	cwd: string;
	agentDir?: string;
	readFile?: (path: string) => string | undefined;
}

function defaultReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Every permissions file that applies to `cwd`, lowest precedence first. */
export function policyPaths(cwd: string, agentDir = join(homedir(), ".reef", "agent")): { path: string; precedence: number }[] {
	const paths: { path: string; precedence: number }[] = [
		{ path: join(agentDir, "permissions.json"), precedence: PRECEDENCE.user },
		{ path: join(agentDir, "permissions.enterprise.json"), precedence: PRECEDENCE.enterprise },
	];
	// Folder rules apply from the repository root down, so the deepest folder wins.
	const parts = resolve(cwd).split("/").filter(Boolean);
	const ancestors: string[] = [];
	for (let index = 1; index <= parts.length; index += 1) ancestors.push(`/${parts.slice(0, index).join("/")}`);
	const projectPaths = ancestors.map((dir) => join(dir, ".reef", "permissions.json"));
	// Only the project root is privileged; intermediate folders are nested and rank below it.
	const projectIndex = projectPaths.findIndex((path) => defaultReadFile(join(path.split("/.reef/")[0], "package.json")) !== undefined);
	const start = projectIndex >= 0 ? projectIndex : 0;
	for (let index = start; index < projectPaths.length; index += 1) {
		paths.push({ path: projectPaths[index], precedence: PRECEDENCE.project + (index - start) });
	}
	paths.push({ path: join(resolve(cwd), ".reef", "permissions.local.json"), precedence: PRECEDENCE.local });
	return paths;
}

/** Load the builtin rules plus every file that applies. */
export function loadPolicy(options: LoadPolicyOptions): LoadedPolicy {
	const read = options.readFile ?? defaultReadFile;
	const rules: PolicyRule[] = BUILTIN_RULES.map((rule) => ({
		...rule,
		source: "builtin",
		precedence: PRECEDENCE.builtin,
		enabled: true,
	}));
	const problems: string[] = [];
	const sources: string[] = [];

	for (const { path, precedence } of policyPaths(options.cwd, options.agentDir)) {
		const text = read(path);
		if (text === undefined) continue;
		sources.push(path);
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			problems.push(`${path}: not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
			continue;
		}
		const result = validatePolicyDocument(parsed, path, precedence);
		problems.push(...result.problems);
		rules.push(...result.rules);
	}

	// `enabled: false` still shadows lower-precedence rules with the same id.
	const shadowed = new Map<string, number>();
	for (const rule of rules) {
		const best = shadowed.get(rule.id);
		if (best === undefined || rule.precedence > best) shadowed.set(rule.id, rule.precedence);
	}
	// A disabled rule is inert, but it still claims its id: the lower-precedence rule with the same
	// id does not quietly take over.
	const effective = rules.filter((rule) => rule.enabled !== false && shadowed.get(rule.id) === rule.precedence);

	return { rules: effective, problems, sources };
}

export interface Resolution {
	decision: Decision;
	rule?: PolicyRule;
	/** Every rule that matched, highest precedence first. */
	competing: PolicyRule[];
}

/** Resolve one shell command against the effective rules. No match means "no opinion". */
export function resolveCommand(command: string, rules: readonly PolicyRule[]): Resolution | undefined {
	const matching = rules.filter((rule) => ruleMatches(rule, command));
	if (matching.length === 0) return undefined;
	const topPrecedence = Math.max(...matching.map((rule) => rule.precedence));
	const atTop = matching.filter((rule) => rule.precedence === topPrecedence);
	const winner = atTop.sort((a, b) => DECISION_RANK[b.decision] - DECISION_RANK[a.decision])[0];
	return {
		decision: winner.decision,
		rule: winner,
		competing: matching.sort((a, b) => b.precedence - a.precedence),
	};
}
