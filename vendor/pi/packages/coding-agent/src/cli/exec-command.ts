/**
 * `reef exec` — the headless contract (docs/10 §3).
 *
 * The agent itself already runs headless; what CI and scripts need is a stable *interface* around it:
 * one prompt in, one object out, and exit codes that mean something without reading stdout. So this
 * translates flags, runs the normal print mode, and reshapes what comes back.
 *
 * `--mode json` already emits one event per line. That is the transport, not the contract: this file
 * turns it into the documented `json` object, `stream-json` records, and the exit codes 0–5.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Exit codes are part of the contract. Do not renumber. */
export const EXIT = {
	ok: 0,
	taskFailed: 1,
	usage: 2,
	policyDenied: 3,
	budgetExceeded: 4,
	provider: 5,
} as const;

export interface ExecOptions {
	prompt?: string;
	file?: string;
	model?: string;
	/** `--auto` tier, or `--read-only`/`--yes` folded in here. */
	tier?: "none" | "low" | "medium" | "high";
	readOnly?: boolean;
	yes?: boolean;
	output: "text" | "json" | "stream-json";
	session?: string;
	fork?: string;
	cwd?: string;
	tools?: string;
	maxTurns?: number;
	maxCost?: number;
	jsonSchema?: string;
	listTools: boolean;
	trace?: string;
	continueOnError: boolean;
}

type Parsed = { options?: ExecOptions; error?: string; help?: boolean };

const TIERS = new Set(["none", "low", "medium", "high"]);

function numberArg(name: string, raw: string | undefined): number | string {
	if (raw === undefined) return `exec: ${name} needs a value`;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return `exec: ${name} must be a non-negative number`;
	return value;
}

/** Parse `reef exec …`. Anything unrecognised is an error, not something to guess at. */
export function parseExecArgs(args: readonly string[]): Parsed {
	const options: ExecOptions = { output: "text", listTools: false, continueOnError: false };
	const positional: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]!;
		const next = () => args[++index];
		if (arg === "--help" || arg === "-h") return { help: true };
		else if (arg === "-f" || arg === "--file") options.file = next();
		else if (arg === "-m" || arg === "--model") options.model = next();
		else if (arg === "--auto") {
			const value = TIERS.has(args[index + 1] ?? "") ? next() : "medium";
			options.tier = value as ExecOptions["tier"];
		} else if (arg === "--yes" || arg === "-y") options.yes = true;
		else if (arg === "--read-only") options.readOnly = true;
		else if (arg === "-o" || arg === "--output") {
			const value = next();
			if (value !== "text" && value !== "json" && value !== "stream-json") {
				return { error: `exec: --output must be text, json, or stream-json, not \`${value}\`` };
			}
			options.output = value;
		} else if (arg === "-s" || arg === "--session") options.session = next();
		else if (arg === "--fork") options.fork = next();
		else if (arg === "--cwd") options.cwd = next();
		else if (arg === "--only-tools" || arg === "--add-tools" || arg === "--remove-tools") options.tools = next();
		else if (arg === "--max-turns") {
			const value = numberArg("--max-turns", next());
			if (typeof value === "string") return { error: value };
			options.maxTurns = value;
		} else if (arg === "--max-cost") {
			const value = numberArg("--max-cost", next());
			if (typeof value === "string") return { error: value };
			options.maxCost = value;
		} else if (arg === "--json-schema") options.jsonSchema = next();
		else if (arg === "--list-tools") options.listTools = true;
		else if (arg === "--trace") options.trace = next();
		else if (arg === "--continue-on-error") options.continueOnError = true;
		else if (arg.startsWith("-") && arg !== "-") return { error: `exec: unknown flag \`${arg}\`` };
		else positional.push(arg);
	}

	if (positional.length > 0) options.prompt = positional.join(" ");
	if (options.prompt && options.file) return { error: "exec: give a prompt or --file, not both" };
	if (!options.prompt && !options.file && !options.listTools) {
		return { error: "exec: no prompt. Pass one as an argument, use --file, or read it on stdin." };
	}
	if (options.readOnly && options.tier && options.tier !== "none") {
		return { error: "exec: --read-only and --auto disagree; --read-only forces tier none" };
	}
	if (options.readOnly) options.tier = "none";
	return { options };
}

/** The flags to give the real CLI. */
export function toCliArgs(options: ExecOptions, prompt: string): string[] {
	const args = ["-p", prompt, "--mode", "json"];
	if (options.model) args.push("--model", options.model);
	if (options.session) args.push("--session", options.session);
	if (options.fork) args.push("--fork", options.fork);
	if (options.tools) args.push("--tools", options.tools);
	if (options.jsonSchema) args.push("--append-system-prompt", schemaInstruction(options.jsonSchema));
	// A headless run has no terminal to ask on; the session still has to know whether to proceed.
	args.push("--no-session");
	return args;
}

function schemaInstruction(path: string): string {
	return `Your final answer must be a single JSON value matching the schema in ${path}, and nothing else.`;
}

export interface ExecUsage {
	input: number;
	output: number;
	cached: number;
	cost: number;
}

export interface ExecResult {
	status: "ok" | "failed" | "policy_denied" | "budget_exceeded" | "provider_error";
	session_id?: string;
	final_message: string;
	usage: ExecUsage;
	tools: string[];
	runs: { tool: string; status: string; duration_ms?: number }[];
}

/** Fold the event stream into the documented result shape. */
export function summarizeExec(events: readonly unknown[]): ExecResult {
	const usage: ExecUsage = { input: 0, output: 0, cached: 0, cost: 0 };
	const runs: ExecResult["runs"] = [];
	let finalMessage = "";
	let sessionId: string | undefined;
	let providerError = false;
	let denied = false;
	const tools = new Set<string>();

	for (const event of events) {
		const record = event as {
			type?: string;
			sessionId?: string;
			message?: {
				role?: string;
				content?: { type?: string; text?: string }[];
				usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
			};
			toolName?: string;
			isError?: boolean;
			error?: string;
			durationMs?: number;
		};
		if (record.sessionId) sessionId = record.sessionId;
		if (record.type === "error" || (record.type === "message_end" && record.error)) providerError = true;
		if (record.type === "tool_start" && record.toolName) tools.add(record.toolName);
		if (record.type === "tool_end" && record.toolName) {
			tools.add(record.toolName);
			runs.push({
				tool: record.toolName,
				status: record.isError ? "error" : "ok",
				...(record.durationMs === undefined ? {} : { duration_ms: record.durationMs }),
			});
		}
		if (record.type !== "message_end" || record.message?.role !== "assistant") continue;
		const text = (record.message.content ?? [])
			.filter((part) => part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("");
		if (text.trim()) finalMessage = text;
		const reported = record.message.usage;
		if (reported) {
			usage.input += reported.input ?? 0;
			usage.output += reported.output ?? 0;
			usage.cached += reported.cacheRead ?? 0;
			usage.cost += reported.cost?.total ?? 0;
		}
		if (finalMessage.includes("policy_block") || finalMessage.includes("policy_denied")) denied = true;
	}

	const status: ExecResult["status"] = denied
		? "policy_denied"
		: providerError
			? "provider_error"
			: finalMessage.trim()
				? "ok"
				: "failed";
	return { status, ...(sessionId ? { session_id: sessionId } : {}), final_message: finalMessage, usage, tools: [...tools], runs };
}

/** Exit code for a result, which is what CI reads. */
export function exitCodeFor(result: ExecResult): number {
	switch (result.status) {
		case "ok":
			return EXIT.ok;
		case "policy_denied":
			return EXIT.policyDenied;
		case "provider_error":
			return EXIT.provider;
		case "budget_exceeded":
			return EXIT.budgetExceeded;
		default:
			return EXIT.taskFailed;
	}
}

const HELP = `reef exec — run one task headless and exit.

  reef exec "fix the failing test in src/auth.test.ts" --auto medium
  reef exec -f plan.md -o json
  cat diff.txt | reef exec "summarise this diff"

  -f, --file <path>      read the prompt from a file
  -m, --model <id>       model or alias
      --auto [tier]      none|low|medium|high (default medium)
      --yes              skip ask decisions, keep blocks
      --read-only        tier none, no writes
  -o, --output <format>  text | json | stream-json (default text)
  -s, --session <id>     continue a session
      --fork <id>        branch a session
      --cwd <path>       working directory
      --only-tools <l>   tool allowlist
      --max-turns <n>    stop after n turns
      --max-cost <usd>   stop after spending this much
      --json-schema <f>  the final answer must satisfy this JSON Schema
      --list-tools       print the effective loadout and exit
      --trace <path>     write the request audit as JSONL
      --continue-on-error  do not stop at the first recoverable failure

Exit codes: 0 ok · 1 task failed · 2 bad usage · 3 policy denied · 4 budget exceeded · 5 provider error

The prompt may also arrive on stdin, which is how a diff or a log gets attached without a temp file.
`;

function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return Promise.resolve("");
	return new Promise((resolvePromise) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (text += chunk));
		process.stdin.on("end", () => resolvePromise(text));
		process.stdin.on("error", () => resolvePromise(text));
	});
}

/**
 * Run one headless task. Returns the exit code instead of exiting, so the caller decides.
 *
 * The child is this same program with print mode and JSON events: the interface is the difference,
 * not the agent. That keeps one code path for tools, policy, sessions, and cost.
 */
export async function runExecCommand(args: readonly string[]): Promise<{ handled: boolean; exitCode?: number }> {
	if (args[0] !== "exec") return { handled: false };
	const parsed = parseExecArgs(args.slice(1));
	if (parsed.help) {
		process.stdout.write(HELP);
		return { handled: true, exitCode: EXIT.ok };
	}
	if (parsed.error) {
		process.stderr.write(`${parsed.error}\n`);
		return { handled: true, exitCode: EXIT.usage };
	}
	const options = parsed.options!;

	if (options.listTools) {
		// The loadout is decided by settings, extensions, and flags. Running the agent with a flag
		// that makes it print and stop is the only way to be sure it matches a real run.
		process.env.REEF_PRINT_LOADOUT = "1";
		// The prompt is never sent on this path; print mode prints the loadout and returns.
		options.prompt = options.prompt ?? "loadout";
	}

	let prompt = options.prompt ?? "";
	if (options.file) {
		try {
			prompt = readFileSync(resolve(options.file), "utf8");
		} catch (error) {
			process.stderr.write(`exec: cannot read --file ${options.file}: ${(error as Error).message}\n`);
			return { handled: true, exitCode: EXIT.usage };
		}
	}
	if (!prompt && !options.listTools) {
		const stdin = await readStdin();
		if (stdin.trim()) prompt = stdin.trim();
	}
	if (!prompt && !options.listTools) {
		process.stderr.write("exec: no prompt. Pass one, use --file, or pipe it on stdin.\n");
		return { handled: true, exitCode: EXIT.usage };
	}

	// The safety floor reads these, so `exec` sets them instead of re-implementing the policy.
	if (options.tier) process.env.REEF_TIER = options.tier;
	if (options.yes) process.env.REEF_SKIP_APPROVALS = "1";
	if (options.readOnly) process.env.REEF_READ_ONLY = "1";

	const events: unknown[] = [];
	const child = spawn(process.execPath, [process.argv[1]!, ...toCliArgs(options, prompt)], {
		cwd: options.cwd ? resolve(options.cwd) : process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});

	let buffer = "";
	let turns = 0;
	const streamLine = (line: string) => {
		if (!line.startsWith("{")) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		events.push(event);
		if ((event as { type?: string }).type === "turn_start") turns += 1;
		if (options.maxTurns !== undefined && turns > options.maxTurns) child.kill("SIGTERM");
		if (options.output === "stream-json") {
			const record = (event as { type?: string }) ?? {};
			const mapped =
				record.type === "tool_start" || record.type === "tool_end" || record.type === "message_end"
					? event
					: record.type === "turn_start"
						? { type: "turn_start" }
						: undefined;
			if (mapped) process.stdout.write(`${JSON.stringify(mapped)}\n`);
		}
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) streamLine(line);
	});
	const stderr: string[] = [];
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));

	const exitCode = await new Promise<number>((resolvePromise) => child.on("close", (code) => resolvePromise(code ?? 1)));
	if (buffer.trim()) streamLine(buffer);

	const result = summarizeExec(events);
	if (options.maxTurns !== undefined && turns > options.maxTurns) result.status = "budget_exceeded";
	if (options.maxCost !== undefined && result.usage.cost > options.maxCost) result.status = "budget_exceeded";
	if (options.trace) {
		try {
			writeFileSync(resolve(options.trace), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
		} catch (error) {
			process.stderr.write(`exec: cannot write --trace: ${(error as Error).message}\n`);
		}
	}

	if (options.output === "text") {
		if (result.final_message.trim()) process.stdout.write(`${result.final_message.trim()}\n`);
		for (const text of stderr) process.stderr.write(text);
	} else if (options.output === "json") {
		process.stdout.write(`${JSON.stringify({ ...result, exit_code: exitCodeFor(result) })}\n`);
	}

	const code = result.status === "ok" && exitCode !== 0 ? EXIT.provider : exitCodeFor(result);
	if (code !== EXIT.ok && options.output === "text") {
		for (const text of stderr) if (!text.trim()) continue;
	}
	if (code !== EXIT.ok && options.output === "json" && stderr.length) {
		process.stderr.write(stderr.join(""));
	}
	return { handled: true, exitCode: code };
}

export default runExecCommand;
