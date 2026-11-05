/**
 * The safety floor: tier defaults, the built-in rules, and one function that decides.
 *
 * The floor is deliberately small. It exists so a fresh clone with no config cannot run
 * `rm -rf /`, cannot read a private key into a transcript, and cannot push over someone's
 * history. It asks before anything public or remote. Everything it cannot classify falls back
 * to the tier default, and in a headless run an `ask` is a `block` — never a silent yes.
 */

import {
	BUILTIN_RULES,
	type BuiltinRule,
	type Decision,
	FILTER_PREFIXES,
	matchesPrefix,
	parseSegments,
	READ_ONLY_PREFIXES,
	ruleMatches,
} from "./rules.ts";

export type Tier = "none" | "low" | "medium" | "high";

export const TIERS: readonly Tier[] = ["none", "low", "medium", "high"];

export function isTier(value: unknown): value is Tier {
	return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

export interface Call {
	tool: string;
	/** Parsed arguments, already validated against the tool's schema. */
	input: Record<string, unknown>;
	/** Set when a script made this call. */
	nested: boolean;
}

export interface Verdict {
	decision: Decision;
	reason: string;
	/** The rule that decided, when a rule did. */
	ruleId?: string;
	/** Short label for the UI: `read-only`, `write inside the repo`, `remote write`, … */
	scopes: string[];
}

export interface Context {
	cwd: string;
	tier: Tier;
	/** No human to ask. `ask` becomes `block`. */
	headless: boolean;
	/** Skip `ask` decisions (--yes). Never skips `block`. */
	skipApprovals: boolean;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "search"]);
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "patch"]);

/** Tools that only change state through other tools, so the calls themselves are allowed. */
const TRANSPARENT_TOOLS = new Set(["script", "wait_for_script", "task", "task_output", "task_stop", "tool_search"]);

/** Whether a path is inside `cwd`. Symlinks are not resolved here; the post-check reports them. */
export function insideCwd(cwd: string, path: string): boolean {
	if (!path || path === ".") return true;
	const normalized = path.startsWith("/") ? path : `${cwd.replace(/\/$/, "")}/${path}`;
	const base = cwd.replace(/\/$/, "");
	const parts = normalized.split("/");
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			resolved.pop();
			continue;
		}
		resolved.push(part);
	}
	return `/${resolved.join("/")}`.startsWith(`${base}/`) || `/${resolved.join("/")}` === base;
}

/** Whether every segment of a command is read-only (read commands plus neutral filters). */
export function isReadOnlyCommand(command: string): boolean {
	const segments = parseSegments(command);
	if (!segments || segments.length === 0) return false;
	return segments.every(
		(tokens) =>
			READ_ONLY_PREFIXES.some((prefix) => matchesPrefix(tokens, prefix)) ||
			FILTER_PREFIXES.some((prefix) => matchesPrefix(tokens, prefix)),
	);
}

function matchRule(command: string, rules: readonly BuiltinRule[]): BuiltinRule | undefined {
	// Ask and block rules may match extracted inner segments, so the whole line is fair game.
	for (const rule of rules) {
		if (!rule.match.prefix && !rule.match.anyToken && !rule.match.regex) continue;
		if (ruleMatches(rule, command)) return rule;
	}
	return undefined;
}

/** The tier default for a call no rule claimed. */
function tierDefault(call: Call, context: Context): Verdict {
	const { tier } = context;
	const readOnly = typeof call.input.command === "string" ? isReadOnlyCommand(call.input.command) : false;

	if (READ_TOOLS.has(call.tool)) {
		return { decision: "allow", reason: "Reading.", scopes: ["read"] };
	}
	if (TRANSPARENT_TOOLS.has(call.tool)) {
		return { decision: "allow", reason: "Calls it makes are checked one by one.", scopes: ["delegates"] };
	}
	if (WRITE_TOOLS.has(call.tool)) {
		const path = String(call.input.path ?? call.input.file_path ?? "");
		const inside = insideCwd(context.cwd, path);
		if (tier === "none") {
			return { decision: "ask", reason: "The `none` tier does not write.", scopes: ["write"] };
		}
		if (!inside) {
			return { decision: "ask", reason: "That path is outside the project.", scopes: ["write", "outside-repo"] };
		}
		return { decision: "allow", reason: "Writing inside the project.", scopes: ["write"] };
	}
	if (call.tool === "bash") {
		const command = String(call.input.command ?? "");
		if (readOnly) return { decision: "allow", reason: "Read-only command.", scopes: ["read-only"] };
		switch (tier) {
			case "none":
				return { decision: "ask", reason: "The `none` tier does not run commands.", scopes: ["shell"] };
			case "low":
				return { decision: "ask", reason: "The `low` tier asks before commands that change anything.", scopes: ["shell"] };
			case "medium":
			case "high":
				return { decision: "allow", reason: "Shell command at the current tier.", scopes: ["shell"] };
		}
	}
	// Unknown tool: allowed at medium and above, asked below, never silently at `none`.
	if (tier === "none" || tier === "low") {
		return { decision: "ask", reason: `The \`${tier}\` tier asks before \`${call.tool}\`.`, scopes: [call.tool] };
	}
	return { decision: "allow", reason: "Allowed at the current tier.", scopes: [call.tool] };
}

/** Decide one tool call. */
export function decide(call: Call, context: Context, rules: readonly BuiltinRule[] = BUILTIN_RULES): Verdict {
	const command = typeof call.input.command === "string" ? call.input.command : undefined;
	const verdict = command
		? (() => {
				const rule = matchRule(command, rules);
				return rule
					? { decision: rule.decision, reason: rule.reason, ruleId: rule.id, scopes: [rule.id.replace(/^builtin\//, "")] }
					: tierDefault(call, context);
			})()
		: tierDefault(call, context);

	// Belt and braces: a secret path is a secret path whatever the tool.
	const pathText = [call.input.path, call.input.file_path, call.input.command]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	if (verdict.decision !== "block" && /\B\.env(\.[\w-]+)?\b|\bid_(rsa|ed25519)\b|\b\.ssh\/|\bcredentials\.json\b|\B\.pem\b/.test(pathText)) {
		const rule = rules.find((candidate) => candidate.id === "builtin/secret-paths");
		return { decision: "block", reason: rule?.reason ?? "That path holds credentials.", ruleId: "builtin/secret-paths", scopes: ["secret"] };
	}

	if (verdict.decision === "ask" && (context.headless || context.skipApprovals)) {
		return {
			decision: "block",
			reason: context.headless
				? `${verdict.reason} No human is here to approve it, so it was denied.`
				: `${verdict.reason} Approvals were skipped, so it was denied.`,
			ruleId: verdict.ruleId,
			scopes: verdict.scopes,
		};
	}
	return verdict;
}
