/**
 * Running a child agent.
 *
 * The child is a separate `reef -p` process, not a second Agent in this one, for three reasons:
 * its context, its tool set, and its failure mode are all separate. A child that hangs or crashes
 * cannot take the parent with it, and killing it is killing a process.
 *
 * The child is asked for JSON events (`--mode json`), so the parent gets the child's final text and
 * its exact usage — cost attribution is a measurement, not an estimate.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import type { AgentDefinition } from "./definitions.ts";
import { toolsFor } from "./definitions.ts";

/** A child's final message is capped here. A subagent that needs more than this is a badly scoped task. */
export const MAX_RETURN_TOKENS = 2000;
const MAX_RETURN_CHARS = MAX_RETURN_TOKENS * 4;

export interface TaskSpec {
	/** One paragraph, outcome-shaped. */
	prompt: string;
	/** Facts the child needs, curated by the parent. */
	context?: string;
	constraints?: string[];
	done_when?: string[];
	return_format?: "summary" | "patch" | "findings" | "json";
	/** Overrides the definition's model. */
	model?: string;
}

export interface TaskUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TaskResult {
	status: "done" | "failed" | "killed";
	/** The child's final message, capped. */
	message: string;
	turns: number;
	usage: TaskUsage;
	durationMs: number;
	exitCode?: number;
	/** The full event stream, for `.reef/runs/` and for debugging. */
	events: number;
}

export interface RunChildOptions {
	definition: AgentDefinition;
	spec: TaskSpec;
	cwd: string;
	signal?: AbortSignal;
	/** The launcher the parent was started with. */
	launcher: { command: string; args: string[] };
	onProgress?: (line: string) => void;
}

/**
 * The child's system prompt: the definition body, then the contract. Short by design — the child
 * does not get the parent's rules, tools, or context files.
 */
export function buildChildPrompt(definition: AgentDefinition, spec: TaskSpec): string {
	const sections: string[] = [definition.body.trim(), "", "<delegation>"];
	sections.push(`You are a subagent named \`${definition.name}\`. You report to one caller and cannot ask it questions.`);
	sections.push("You receive a specification, not a conversation. Everything you need is below.");
	sections.push(`Return exactly one message.${spec.return_format === "json" ? " It must be valid JSON." : ""}`);
	sections.push(`Keep it under ${MAX_RETURN_TOKENS} tokens. No preamble, no restating the task.`);
	sections.push("</delegation>", "", "<specification>", spec.prompt.trim());
	if (spec.context) sections.push("", "<context>", spec.context.trim(), "</context>");
	if (spec.constraints?.length) sections.push("", "Constraints:", ...spec.constraints.map((item) => `- ${item}`));
	if (spec.done_when?.length) sections.push("", "Done when:", ...spec.done_when.map((item) => `- ${item}`));
	if (spec.return_format) sections.push("", `Return format: ${spec.return_format}`);
	sections.push("</specification>");
	return sections.join("\n");
}

/** Cap the return without cutting a word in half. */
export function capReturn(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MAX_RETURN_CHARS) return trimmed;
	return `${trimmed.slice(0, MAX_RETURN_CHARS)}\n\n[truncated at ${MAX_RETURN_TOKENS} tokens]`;
}

function emptyUsage(): TaskUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

/** Pull the final assistant text and the summed usage out of the child's event stream. */
export function summarizeEvents(lines: readonly string[]): { message: string; turns: number; usage: TaskUsage } {
	const usage = emptyUsage();
	let message = "";
	let turns = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let event: {
			type?: string;
			message?: { role?: string; content?: { type?: string; text?: string }[]; usage?: Partial<TaskUsage> };
		};
		try {
			event = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (event.type === "turn_start") turns += 1;
		if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
		const text = (event.message.content ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
		if (text.trim()) message = text;
		const reported = event.message.usage as Record<string, unknown> | undefined;
		if (reported) {
			const num = (key: string): number => {
				const value = reported[key];
				const parsed = typeof value === "number" ? value : Number(value);
				return Number.isFinite(parsed) ? parsed : 0;
			};
			usage.input += num("input");
			usage.output += num("output");
			usage.cacheRead += num("cacheRead");
			usage.cacheWrite += num("cacheWrite");
			// `cost` is an object (`{input, output, cacheRead, cacheWrite, total}`), not a scalar.
			const cost = reported.cost;
			if (typeof cost === "number") usage.cost += Number.isFinite(cost) ? cost : 0;
			else if (cost && typeof cost === "object") {
				const total = (cost as Record<string, unknown>).total;
				const parsed = typeof total === "number" ? total : Number(total);
				if (Number.isFinite(parsed)) usage.cost += parsed;
			}
		}
	}
	return { message: capReturn(message), turns, usage };
}

/** Run a child agent to completion. */
export async function runChild(options: RunChildOptions): Promise<TaskResult> {
	const startedAt = Date.now();
	const prompt = buildChildPrompt(options.definition, options.spec);
	const tools = toolsFor(options.definition);
	const model = options.spec.model ?? (options.definition.model === "inherit" ? undefined : options.definition.model);

	const args = [
		...options.launcher.args,
		"-p",
		options.spec.prompt,
		"--mode",
		"json",
		"--no-session",
		"--system-prompt",
		prompt,
		// The child gets its definition's tools directly: there is no parent transcript to protect.
		"--tools",
		tools.join(","),
	];
	if (model) args.push("--model", model);

	const child = spawn(options.launcher.command, args, {
		cwd: options.cwd,
		env: { ...process.env, REEF_SUBAGENT: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines: string[] = [];
	let stderrText = "";

	const abort = () => child.kill("SIGTERM");
	options.signal?.addEventListener("abort", abort, { once: true });

	await new Promise<void>((resolve) => {
		let buffered = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffered += chunk.toString("utf8");
			const parts = buffered.split("\n");
			buffered = parts.pop() ?? "";
			for (const part of parts) {
				lines.push(part);
				if (part.includes('"type":"turn_start"')) options.onProgress?.(`turn ${lines.length}`);
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrText += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			stderrText += `\n${error.message}`;
			resolve();
		});
		child.on("close", () => resolve());
	});

	options.signal?.removeEventListener("abort", abort);
	const exitCode = child.exitCode ?? undefined;
	const summary = summarizeEvents(lines);
	const killed = options.signal?.aborted === true;
	const failed = !killed && exitCode !== 0 && summary.message === "";

	return {
		status: killed ? "killed" : failed ? "failed" : "done",
		message:
			summary.message ||
			(failed ? `The subagent failed (exit ${exitCode ?? "?"}): ${stderrText.trim().slice(0, 400)}` : "(no message)"),
		turns: summary.turns,
		usage: summary.usage,
		durationMs: Date.now() - startedAt,
		exitCode,
		events: lines.length,
	};
}

/**
 * The family of a model id, which for every provider we have seen is the first segment:
 * `claude-haiku-5-5` → `claude`, `deepseek-v4-pro` → `deepseek`, `gpt-6-luna` → `gpt`.
 *
 * Used only to give a reviewer a different family from the driver, so two models do not share the
 * same blind spot. It is not a ranking and nothing else reads it.
 */
export function modelFamily(modelId: string): string {
	return modelId.split(/[-/]/)[0]?.toLowerCase() ?? modelId;
}

export interface ModelCandidate {
	provider: string;
	id: string;
}

/**
 * Pick a model from a different family than the one named. `undefined` when every available model
 * shares the family, which is the honest answer: independence cannot be manufactured from one vendor.
 */
export function independentModel(driverId: string, available: readonly ModelCandidate[]): ModelCandidate | undefined {
	const family = modelFamily(driverId);
	const candidates = available.filter((model) => modelFamily(model.id) !== family);
	if (candidates.length === 0) return undefined;
	// Prefer a full model over a small or free one, then a stable id so repeated runs agree.
	const rank = (id: string) => (/free|flash|mini|small|haiku/i.test(id) ? 1 : 0);
	return [...candidates].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id))[0];
}

/** Where the parent's launcher lives, so the child starts the same program. */
export function resolveLauncher(): { command: string; args: string[] } {
	const entry = process.argv[1];
	return { command: process.execPath, args: entry ? [entry] : [] };
}

/** `.reef/runs/tasks/<id>.jsonl`, relative to the project. */
export function runsPath(cwd: string, id: string): string {
	return join(cwd, ".reef", "runs", "tasks", `${id}.jsonl`);
}
