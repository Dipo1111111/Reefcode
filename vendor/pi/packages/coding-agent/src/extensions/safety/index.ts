/**
 * The safety floor as an extension: one `tool_call` handler between the model and every tool.
 *
 * It runs before the call executes, for direct calls and for calls a script makes (`ctx.executeTool`
 * goes through the same pipeline), so a script cannot reach a tool the direct path would refuse.
 *
 * A block is a tool result the model reads, not a crash: `policy_block` with the rule id and the
 * reason, so the next attempt can be a better one.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { checkRules } from "./rules.ts";
import { type Context, decide, isTier, type Tier, TIERS } from "./tiers.ts";

export interface SafetyOptions {
	tier?: Tier;
	headless?: boolean;
}

function readTier(pi: ExtensionAPI): Tier {
	const fromEnv = process.env.REEF_TIER;
	if (isTier(fromEnv)) return fromEnv;
	if (process.env.REEF_READ_ONLY === "1" || process.env.REEF_READ_ONLY === "true") return "none";
	const configured = (pi.getSettings() as { safety?: { tier?: unknown } }).safety?.tier;
	return isTier(configured) ? configured : SETTINGS_DEFAULTS.safety.tier;
}

function readSkipApprovals(pi: ExtensionAPI): boolean {
	if (process.env.REEF_SKIP_APPROVALS === "1") return true;
	const configured = (pi.getSettings() as { safety?: { skipApprovals?: unknown } }).safety?.skipApprovals;
	return configured === true;
}

export function createSafetyExtension(options: SafetyOptions = {}): ExtensionFactory {
	return (pi) => {
		// A rule that fails its own examples is inert. Recording it once beats trusting it.
		const problems = checkRules();

		pi.registerCommand("safety", {
			description: "Show the current autonomy tier and what it allows",
			handler: async (_args: string, ctx) => {
				const tier = options.tier ?? readTier(pi);
				const lines = [
					`Tier: ${tier}`,
					"",
					"none    reads only",
					"low     writes inside the project, asks before shell commands",
					"medium  runs shell commands except the built-in block rules",
					"high    also allows remote writes",
					"",
					"Blocked at every tier: deleting root or home, force-push, history rewrite,",
					"reading credential files, piping a download into a shell.",
					`Approvals skipped: ${readSkipApprovals(pi) ? "yes" : "no"}`,
					`Headless: ${ctx.hasUI ? "no" : "yes (an ask becomes a deny)"}`,
				];
				if (problems.length > 0) lines.push("", ...problems.map((problem) => `rule problem: ${problem}`));
				ctx.ui?.notify?.(lines.join("\n"));
			},
		});

		pi.on("tool_call", async (event, ctx) => {
			const tier = options.tier ?? readTier(pi);
			const context: Context = {
				cwd: ctx.cwd,
				tier,
				headless: options.headless ?? !ctx.hasUI,
				skipApprovals: readSkipApprovals(pi),
			};
			const call = {
				tool: event.toolName,
				input: (event.input ?? {}) as Record<string, unknown>,
				nested: event.parentToolCallId !== undefined,
			};
			const verdict = decide(call, context);
			if (verdict.decision === "allow") return;
			const label = verdict.ruleId ? `policy_block (${verdict.ruleId})` : "policy_block";
			return {
				block: true,
				reason: `${label}: ${verdict.reason}`,
			};
		});
	};
}

export default createSafetyExtension();
