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

		pi.registerCommand("cost", {
			description: "Tokens, cache reuse, and spend for this session",
			handler: async (_args: string, ctx) => {
				const entries = readEntries(ctx.sessionManager.getBranch?.() ?? []);
				if (entries.length === 0) {
					ctx.ui?.notify?.("No model calls recorded yet.");
					return;
				}
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
				const reuse = promptTotal === 0 ? 0 : (sum.cacheRead / promptTotal) * 100;
				const last = entries[entries.length - 1];
				const lines = [
					`Requests:      ${entries.length}`,
					`Input:         ${formatCount(sum.input)}`,
					`Output:        ${formatCount(sum.output)}`,
					`Cache read:    ${formatCount(sum.cacheRead)}`,
					`Cache write:   ${formatCount(sum.cacheWrite)}`,
					`Cache reuse:   ${reuse.toFixed(1)}%`,
					`Cost:          ${formatUsd(sum.cost)}`,
					"",
					`Declared tools: ${last.declaredTools.length ? last.declaredTools.join(", ") : "—"}`,
					`Prompt:        ~${formatCount(last.promptTokens)} tokens (system prompt only)`,
					`Model:         ${last.provider}/${last.model}`,
				];
				ctx.ui?.notify?.(lines.join("\n"));
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

export default createReefStatsExtension();
