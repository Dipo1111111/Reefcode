/**
 * `reef permissions <check|list|validate>` — the policy engine from a terminal, before a session.
 *
 * `check` answers the question a person actually asks ("would this run?") and exits non-zero when the
 * answer is no, so it works in a pre-commit hook. `validate` is the CI gate: a permissions file that
 * does not load is a broken build, not a warning.
 */

import chalk from "chalk";
import { loadPolicy, type PolicyRule, resolveCommand } from "../extensions/safety/policy.ts";
import { parseShell } from "../extensions/safety/shell.ts";
import { type Tier, isTier } from "../extensions/safety/tiers.ts";

const USAGE = `Usage: reef permissions <command> [options]

Commands:
  check "<command>"   Say whether a shell command would run, and which rule decided
  list                List every effective rule with its source
  validate            Load every permissions file and fail on any problem

Options:
  --tier <none|low|medium|high>   Tier used for "no rule matched" (default: settings)
  --json                          Machine-readable output`;

export interface PermissionsCommandResult {
	handled: boolean;
	exitCode?: number;
}

function tierFromArgs(args: readonly string[]): Tier | undefined {
	const index = args.indexOf("--tier");
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || !isTier(value)) return undefined;
	return value;
}

function stripOptions(args: readonly string[]): string[] {
	const kept: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--tier") {
			index += 1;
			continue;
		}
		if (arg === "--json") continue;
		kept.push(arg);
	}
	return kept;
}

function formatRule(rule: PolicyRule): string {
	const scope = rule.match.regex ? `regex ${rule.match.regex}` : rule.match.prefix ? `prefix ${JSON.stringify(rule.match.prefix)}` : `anyToken ${rule.match.anyToken?.join("|")}`;
	return `${rule.decision.padEnd(5)} ${rule.id.padEnd(28)} ${rule.source.padEnd(10)} ${scope}`;
}

export function runPermissionsCommand(args: readonly string[]): PermissionsCommandResult {
	if (args[0] !== "permissions") return { handled: false };
	const json = args.includes("--json");
	const rest = stripOptions(args.slice(1));
	const subcommand = rest[0];

	if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
		console.log(USAGE);
		return { handled: true, exitCode: subcommand ? 0 : 1 };
	}

	const cwd = process.cwd();
	const tier = tierFromArgs(args);
	if (tier) process.env.REEF_TIER = tier;
	const policy = loadPolicy({ cwd });

	if (subcommand === "validate") {
		if (json) {
			console.log(JSON.stringify({ sources: policy.sources, problems: policy.problems }, null, 2));
		} else {
			if (policy.sources.length === 0) console.log(chalk.dim("No permissions files found; the builtin floor applies."));
			for (const source of policy.sources) console.log(`  ${source}`);
			for (const problem of policy.problems) console.error(chalk.red(`  ! ${problem}`));
			if (policy.problems.length === 0) console.log(chalk.green(`Valid: ${policy.rules.length} rules, ${policy.sources.length} files.`));
		}
		return { handled: true, exitCode: policy.problems.length === 0 ? 0 : 1 };
	}

	if (subcommand === "list") {
		if (json) {
			console.log(JSON.stringify(policy.rules.map((rule) => ({ id: rule.id, decision: rule.decision, source: rule.source, precedence: rule.precedence, match: rule.match })), null, 2));
		} else {
			for (const rule of [...policy.rules].sort((a, b) => a.precedence - b.precedence || a.id.localeCompare(b.id))) {
				console.log(formatRule(rule));
			}
			for (const problem of policy.problems) console.error(chalk.red(`  ! ${problem}`));
		}
		return { handled: true, exitCode: policy.problems.length === 0 ? 0 : 1 };
	}

	if (subcommand !== "check") {
		console.error(chalk.red(`Unknown subcommand \`${subcommand}\`.`));
		console.log(USAGE);
		return { handled: true, exitCode: 1 };
	}

	const command = rest.slice(1).join(" ").trim();
	if (!command) {
		console.error(chalk.red("permissions check needs a command."));
		console.log(USAGE);
		return { handled: true, exitCode: 1 };
	}

	const segments = parseShell(command);
	const resolution = resolveCommand(command, policy.rules);

	const decision = resolution?.decision ?? (tier === "none" ? "ask" : "allow");
	if (json) {
		console.log(
			JSON.stringify(
				{
					command,
					decision,
					tier: tier ?? process.env.REEF_TIER ?? "medium",
					parseable: segments !== undefined,
					rule: resolution?.rule ? { id: resolution.rule.id, source: resolution.rule.source, precedence: resolution.rule.precedence } : null,
					competing: resolution?.competing.map((rule) => rule.id) ?? [],
				},
				null,
				2,
			),
		);
	} else {
		const colour = decision === "block" ? chalk.red : decision === "ask" ? chalk.yellow : chalk.green;
		console.log(`${colour(decision)}  ${command}`);
		if (resolution?.rule) {
			console.log(chalk.dim(`  rule: ${resolution.rule.id} (${resolution.rule.source}, precedence ${resolution.rule.precedence})`));
			console.log(chalk.dim(`  why:  ${resolution.rule.reason}`));
		} else {
			console.log(chalk.dim(`  rule: none matched; tier default at \`${tier ?? process.env.REEF_TIER ?? "medium"}\``));
		}
		if (resolution && resolution.competing.length > 1) {
			console.log(chalk.dim(`  also matched: ${resolution.competing.slice(1).map((rule) => rule.id).join(", ")}`));
		}
		if (!segments) console.log(chalk.dim("  note: the command could not be parsed, so only the raw text was matched"));
	}
	return { handled: true, exitCode: decision === "block" ? 1 : 0 };
}
