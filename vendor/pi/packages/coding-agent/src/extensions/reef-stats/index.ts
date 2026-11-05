/**
 * Measurement, in the harness rather than in a spreadsheet.
 *
 * Every assistant message ends with a usage record. This extension appends one `reef-request`
 * entry per model call: tokens, cache split, cost, the declared tool count, and an estimate of the
 * prompt that was sent. `/cost` reads them back.
 *
 * The point is that the numbers in `docs/12-evals.md` can be checked from a normal session:
 * base prompt, cache reuse, and cost per turn are visible without a separate harness.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { TASK_ENTRY_TYPE as REEF_TASK_ENTRY_TYPE } from "../tasks/index.ts";

/** Session custom-entry type holding one model call's usage. */
export const REEF_REQUEST_ENTRY_TYPE = "reef-request";

export interface ReefRequestEntry {
	/** Estimated tokens of the system prompt plus the declared tool schemas. */
	promptTokens: number;
	declaredTools: string[];
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	cost: number;
	model: string;
	provider: string;
	at: number;
}

function estimateTokens(text: string): number {
	return Math.round(text.length / 3.6);
}

function messageUsage(message: unknown): ReefRequestEntry | undefined {
	const candidate = message as
		| {
				role?: string;
				usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; cost?: { total?: number } };
				model?: string;
				provider?: string;
		  }
		| undefined;
	if (!candidate || candidate.role !== "assistant" || !candidate.usage) return undefined;
	const usage = candidate.usage;
	return {
		promptTokens: 0,
		declaredTools: [],
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		reasoning: usage.reasoning ?? 0,
		cost: usage.cost?.total ?? 0,
		model: candidate.model ?? "unknown",
		provider: candidate.provider ?? "unknown",
		at: Date.now(),
	};
}

function formatCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

function formatUsd(value: number): string {
	if (value === 0) return "$0";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

export function createReefStatsExtension(): ExtensionFactory {
	return (pi) => {
		// Read lazily: the runtime is not initialised while the extension is loading.
		let declared: string[] = [];
		const readDeclared = () => {
			try {
				declared = pi.getActiveTools();
			} catch {
				// Loading order: keep the last known set.
			}
			return declared;
		};

		pi.on("tool_call", async () => {
			readDeclared();
			return undefined;
		});

		pi.on("message_end", async (event, ctx) => {
			const entry = messageUsage(event.message);
			if (!entry) return undefined;
			const promptChars = (ctx.getSystemPrompt?.() ?? "").length;
			entry.declaredTools = readDeclared();
			// The tool schemas are not in the prompt string; they are priced by the request. Use the
			// declared names as a lower bound and let the provider's own numbers carry the rest.
			entry.promptTokens = estimateTokens(ctx.getSystemPrompt?.() ?? "");
			void promptChars;
			pi.appendEntry(REEF_REQUEST_ENTRY_TYPE, entry);
			return undefined;
		});

		pi.registerCommand("trace", {
			description: "The last requests: tokens per section, cache verdict, violations",
			handler: async (args: string, ctx) => {
				if (typeof ctx.getRequestAudits !== "function") {
					ctx.ui?.notify?.("Request auditing is not available in this context.");
					return;
				}
				const limit = Number.parseInt(args.trim(), 10) || 5;
				const audits = ctx.getRequestAudits().slice(-limit);
				if (audits.length === 0) {
					ctx.ui?.notify?.("No requests yet.");
					return;
				}
				const lines: string[] = [];
				for (const audit of audits) {
					const head = `#${audit.request}  ${audit.tokens} tok  cache ${audit.cacheablePrefixTokens} tok  ${
						audit.appendOnly ? "append-only" : `BREAK (${audit.breakReason})`
					}`;
					lines.push(head);
					const sections = Object.entries(audit.sectionTokens).sort((a, b) => b[1] - a[1]);
					lines.push(`   ${sections.map(([name, tokens]) => `${name} ${tokens}`).join(" · ")}`);
					lines.push(`   tools: ${audit.tools.join(", ")}`);
					for (const truncated of audit.truncated) {
						lines.push(`   truncated ${truncated.name}: dropped ${truncated.dropped} bytes`);
					}
					for (const violation of audit.violations) lines.push(`   ! ${violation}`);
				}
				const budget = ctx.getSectionBudget();
				if (budget) lines.push("", `total prompt: ${budget.tokens} tokens`);
				ctx.ui?.notify?.(lines.join("\n"));
			},
		});

		pi.registerCommand("cost", {
			description: "Tokens, cache reuse, and spend for this session",
			handler: async (_args: string, ctx) => {
				const summary = summarizeCost(ctx.sessionManager.getBranch?.() ?? []);
				ctx.ui?.notify?.(summary ? formatCost(summary) : "No model calls recorded yet.");
			},
		});
	};
}

function readEntries(branch: readonly unknown[]): ReefRequestEntry[] {
	const entries: ReefRequestEntry[] = [];
	for (const item of branch) {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== REEF_REQUEST_ENTRY_TYPE) continue;
		const data = entry.data as ReefRequestEntry | undefined;
		if (data && typeof data.at === "number") entries.push(data);
	}
	return entries;
}

interface ReefTaskEntry {
	turns?: number;
	usage?: { input?: number; output?: number; cost?: number };
}

function readTaskEntries(branch: readonly unknown[]): ReefTaskEntry[] {
	const entries: ReefTaskEntry[] = [];
	for (const item of branch) {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== REEF_TASK_ENTRY_TYPE) continue;
		const data = entry.data as ReefTaskEntry | undefined;
		if (data && typeof data === "object") entries.push(data);
	}
	return entries;
}

/** Everything `/cost` reports, computed from the session branch. Pure, so it can be tested. */
export interface CostSummary {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	reusePercent: number;
	declaredTools: string[];
	promptTokens: number;
	model: string;
	provider: string;
	tasks: number;
	taskTurns: number;
	taskInput: number;
	taskOutput: number;
	delegatedCost: number;
	total: number;
}

export function summarizeCost(branch: readonly unknown[]): CostSummary | undefined {
	const entries = readEntries(branch);
	if (entries.length === 0) return undefined;
	const sum = entries.reduce(
		(acc, entry) => ({
			input: acc.input + entry.input,
			output: acc.output + entry.output,
			cacheRead: acc.cacheRead + entry.cacheRead,
			cacheWrite: acc.cacheWrite + entry.cacheWrite,
			cost: acc.cost + entry.cost,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
	const promptTotal = sum.input + sum.cacheRead + sum.cacheWrite;
	const last = entries[entries.length - 1]!;

	const delegated = readTaskEntries(branch);
	const tasks = delegated.reduce<{ tasks: number; turns: number; cost: number; input: number; output: number }>(
		(acc, entry) => ({
			tasks: acc.tasks + 1,
			turns: acc.turns + (entry.turns ?? 0),
			cost: acc.cost + (entry.usage?.cost ?? 0),
			input: acc.input + (entry.usage?.input ?? 0),
			output: acc.output + (entry.usage?.output ?? 0),
		}),
		{ tasks: 0, turns: 0, cost: 0, input: 0, output: 0 },
	);

	return {
		requests: entries.length,
		...sum,
		reusePercent: promptTotal === 0 ? 0 : (sum.cacheRead / promptTotal) * 100,
		declaredTools: last.declaredTools,
		promptTokens: last.promptTokens,
		model: last.model,
		provider: last.provider,
		tasks: tasks.tasks,
		taskTurns: tasks.turns,
		taskInput: tasks.input,
		taskOutput: tasks.output,
		delegatedCost: tasks.cost,
		total: sum.cost + tasks.cost,
	};
}

export function formatCost(summary: CostSummary): string {
	const lines = [
		`Requests:      ${summary.requests}`,
		`Input:         ${formatCount(summary.input)}`,
		`Output:        ${formatCount(summary.output)}`,
		`Cache read:    ${formatCount(summary.cacheRead)}`,
		`Cache write:   ${formatCount(summary.cacheWrite)}`,
		`Cache reuse:   ${summary.reusePercent.toFixed(1)}%`,
		`Cost:          ${formatUsd(summary.cost)}`,
		"",
		`Declared tools: ${summary.declaredTools.length ? summary.declaredTools.join(", ") : "—"}`,
		`Prompt:        ~${formatCount(summary.promptTokens)} tokens (system prompt only)`,
		`Model:         ${summary.provider}/${summary.model}`,
	];
	if (summary.tasks > 0) {
		lines.push(
			"",
			`Subagents:     ${summary.tasks} task(s), ${summary.taskTurns} turn(s), ${formatCount(summary.taskInput)} in / ${formatCount(summary.taskOutput)} out`,
			`Delegated:     ${formatUsd(summary.delegatedCost)}`,
			`Total:         ${formatUsd(summary.total)}`,
		);
	}
	return lines.join("\n");
}

export default createReefStatsExtension();
