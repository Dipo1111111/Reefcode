/**
 * The safety floor as an extension: one `tool_call` handler between the model and every tool.
 *
 * It runs before the call executes, for direct calls and for calls a script makes (`ctx.executeTool`
 * goes through the same pipeline), so a script cannot reach a tool the direct path would refuse.
 *
 * A block is a tool result the model reads, not a crash: `policy_block` with the rule id and the
 * reason, so the next attempt can be a better one.
 */

import type { ExtensionAPI, ExtensionFactory, ExtensionUIContext } from "../../core/extensions/types.ts";
import { ApprovalBatcher, describeBatch } from "./approvals.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { type LoadedPolicy, loadPolicy } from "./policy.ts";
import { checkRules } from "./rules.ts";
import { type Context, decideWithPolicy, isTier, type Tier } from "./tiers.ts";

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
		let problems = checkRules();
		let policy: LoadedPolicy | undefined;
		const load = (cwd: string) => {
			policy = loadPolicy({ cwd });
			problems = [...checkRules(), ...policy.problems];
			return policy;
		};
		const current = (cwd: string): LoadedPolicy => policy ?? load(cwd);

		pi.registerCommand("permissions", {
			description: "Show the rules that apply here, or reload them",
			handler: async (args: string, ctx) => {
				if (args.trim() === "reload") load(ctx.cwd);
				const loaded = current(ctx.cwd);
				const lines = [`Rules: ${loaded.rules.length} (${loaded.sources.length} file${loaded.sources.length === 1 ? "" : "s"})`];
				for (const source of loaded.sources) lines.push(`  ${source}`);
				const bySource = new Map<string, number>();
				for (const rule of loaded.rules) bySource.set(rule.source, (bySource.get(rule.source) ?? 0) + 1);
				for (const [source, count] of bySource) lines.push(`  ${source}: ${count}`);
				if (loaded.problems.length > 0) {
					lines.push("", "Problems:");
					for (const problem of loaded.problems) lines.push(`  ! ${problem}`);
				}
				ctx.ui?.notify?.(lines.join("\n"));
			},
		});

		pi.registerCommand("safety", {
			description: "Show the current autonomy tier and what it allows",
			handler: async (_args: string, ctx) => {
				const tier = options.tier ?? readTier(pi);
				const loaded = current(ctx.cwd);
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
				lines.push(`Policy files: ${loaded.sources.length === 0 ? "none" : loaded.sources.join(", ")}`);
				if (problems.length > 0) lines.push("", ...problems.map((problem) => `rule problem: ${problem}`));
				ctx.ui?.notify?.(lines.join("\n"));
			},
		});

		/** Commands the user approved in this session, so the same ask is not shown twice. */
		const approved = new Set<string>();
		// One dialog per batch, not per call: six prompts in a row teaches people to press yes.
		// The dialog belongs to the call that raised it, so the handler records the UI first.
		let activeUI: ExtensionUIContext | undefined;
		const batcher = new ApprovalBatcher({
			confirm: async (requests) => {
				if (!activeUI) return false;
				const { title, body } = describeBatch(requests);
				const ok = await activeUI.confirm(title, body);
				if (ok) for (const request of requests) approved.add(request.tool + "\u0000" + request.summary);
				return ok;
			},
		});

		pi.on("tool_call", async (event, ctx) => {
			activeUI = ctx.ui;
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
			const verdict = decideWithPolicy(call, context, current(ctx.cwd).rules);
			if (verdict.decision === "allow") return;
			if (verdict.decision === "ask" && !context.headless && ctx.ui) {
				// Interactive: ask once per distinct call per session, and once per batch rather than
				// once per call. A repeated ask is noise, not diligence.
				const key = `${call.tool}\u0000${summarize(call)}`;
				if (approved.has(key)) return;
				const allowed = await batcher.ask({ tool: call.tool, summary: summarize(call), reason: verdict.reason });
				if (!allowed) return { block: true, reason: `policy_denied: ${verdict.reason}` };
				return;
			}
			const label = verdict.ruleId ? `policy_block (${verdict.ruleId})` : "policy_block";
			return {
				block: true,
				reason: `${label}: ${verdict.reason}`,
			};
		});
	};
}

/** A short, quotable form of the call for the approval dialog and the block message. */
function summarize(call: { tool: string; input: Record<string, unknown> }): string {
	if (typeof call.input.command === "string") return call.input.command;
	const path = call.input.path ?? call.input.file_path;
	if (typeof path === "string") return path;
	const entries = Object.entries(call.input).slice(0, 3);
	return entries.map(([key, value]) => `${key}=${String(value).slice(0, 60)}`).join(" ");
}

export default createSafetyExtension();
