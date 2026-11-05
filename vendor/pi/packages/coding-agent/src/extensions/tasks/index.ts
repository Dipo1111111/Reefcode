/**
 * Subagents as tools: `task`, `task_output`, `task_stop`.
 *
 * None of them is declared. They live in the script index like every other deferred tool, so the
 * model reaches them with `tools.task(...)` and the request stays two declarations wide.
 *
 * Background tasks share the codemode job registry and the same wake mechanism: a finished task is
 * a follow-up message, not a poll.
 */

import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionFactory, ExtensionToolContext } from "../../core/extensions/types.ts";
import { createJob, finishJob, formatDuration, getJob, listJobs, newJobId, toEntryData, SCRIPT_JOB_ENTRY_TYPE } from "../codemode/jobs.ts";
import { type TaskResult, independentModel, modelFamily, runChild, resolveLauncher } from "./child.ts";
import { BUILTIN_AGENTS, type AgentDefinition, loadDefinitions, toolsFor } from "./definitions.ts";

/** Session entry type for a finished task, so the parent's log carries the cost. */
export const TASK_ENTRY_TYPE = "reef-task";

export interface TaskDetail {
	taskId: string;
	subagent: string;
	status: TaskResult["status"] | "running";
	usage?: TaskResult["usage"];
	turns?: number;
	model?: string;
}

interface TaskState {
	definition: AgentDefinition;
	spec: { prompt: string; context?: string; constraints?: string[]; done_when?: string[]; return_format?: string; model?: string };
	startedAt: number;
	usage?: TaskResult["usage"];
	turns?: number;
	result?: TaskResult;
}

function statusLine(detail: TaskDetail, durationMs?: number): string {
	const parts = [`task ${detail.taskId}`, detail.subagent, detail.status];
	if (detail.turns !== undefined) parts.push(`${detail.turns} turns`);
	if (detail.usage) parts.push(`$${Number(detail.usage.cost ?? 0).toFixed(4)}`);
	if (durationMs !== undefined) parts.push(formatDuration(durationMs));
	return parts.join(" · ");
}

function registerTaskTools(pi: ExtensionAPI): void {
	const tasks = new Map<string, TaskState>();

	const definitionFor = (cwd: string, name: string): AgentDefinition | undefined => {
		const loaded = loadDefinitions(cwd);
		return loaded.definitions.find((entry) => entry.name === name) ?? BUILTIN_AGENTS.find((entry) => entry.name === name);
	};

	const listFor = (cwd: string): AgentDefinition[] => {
		const loaded = loadDefinitions(cwd);
		const byName = new Map(loaded.definitions.map((entry) => [entry.name, entry]));
		for (const builtin of BUILTIN_AGENTS) if (!byName.has(builtin.name)) byName.set(builtin.name, builtin);
		return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	};

	/**
	 * Turn a definition's `model` into something the child CLI accepts.
	 * `inherit` starts nothing, so the child uses the configured default (the same model as the parent in
	 * practice). `different` picks another family when one is configured, and says so in the result when
	 * there is not.
	 */
	const resolveModel = (
		requested: string | undefined,
		definitionModel: string,
		ctx: ExtensionToolContext,
	): { model?: string; note?: string } => {
		if (requested) return { model: requested };
		if (definitionModel !== "different") {
			return definitionModel === "inherit" ? {} : { model: definitionModel };
		}
		const driver = ctx.model?.id ?? "";
		const available = ctx.modelRegistry
			.getAvailable()
			.filter((model) => model.provider === ctx.model?.provider)
			.map((model) => ({ provider: model.provider, id: model.id }));
		const chosen = independentModel(driver, available);
		if (!chosen) {
			return { note: `no model outside the ${modelFamily(driver)} family is configured; used the default` };
		}
		return { model: chosen.id, note: `independent of ${modelFamily(driver)}` };
	};

	const start = (
		args: {
			subagent_type?: string;
			description?: string;
			prompt: string;
			context?: string;
			constraints?: string[];
			done_when?: string[];
			return_format?: "summary" | "patch" | "findings" | "json";
			model?: string;
		},
		ctx: ExtensionToolContext,
		toolCallId: string,
		onUpdate?: (text: string) => void,
	): { id: string; promise: Promise<AgentToolResult<TaskDetail>>; state: TaskState } | { error: string } => {
		const name = args.subagent_type ?? "explorer";
		const definition = definitionFor(ctx.cwd, name);
		if (!definition) {
			const available = listFor(ctx.cwd).map((entry) => entry.name).join(", ");
			return { error: `No subagent named \`${name}\`. Available: ${available}` };
		}
		const resolved = resolveModel(args.model, definition.model, ctx);
		const id = newJobId().replace("job-", "task-");
		const abort = new AbortController();
		const job = createJob<TaskDetail>(id, toolCallId, abort);
		const state: TaskState = {
			definition,
			spec: {
				prompt: args.description ? `${args.prompt}\n\n(${args.description})` : args.prompt,
				context: args.context,
				constraints: args.constraints,
				done_when: args.done_when,
				return_format: args.return_format,
				model: resolved.model,
			},
			startedAt: Date.now(),
		};
		tasks.set(id, state);

		const launcher = resolveLauncher();
		const promise = runChild({
			definition,
			spec: {
				prompt: state.spec.prompt,
				context: args.context,
				constraints: args.constraints,
				done_when: args.done_when,
				return_format: args.return_format,
				model: resolved.model,
			},
			cwd: ctx.cwd,
			signal: abort.signal,
			launcher,
			onProgress: (line) =>
				onUpdate?.(`${statusLine({ taskId: id, subagent: name, status: "running" }, Date.now() - state.startedAt)} · ${line}`),
		}).then((result) => {
			state.result = result;
			state.usage = result.usage;
			state.turns = result.turns;
			finishJob(job, result.status === "done" ? "done" : result.status === "killed" ? "killed" : "failed");
			const detail: TaskDetail = {
				taskId: id,
				subagent: name,
				status: result.status,
				usage: result.usage,
				turns: result.turns,
				model: resolved.model ?? definition.model,
			};
			pi.appendEntry(TASK_ENTRY_TYPE, {
				...toEntryData(job),
				subagent: name,
				usage: result.usage,
				turns: result.turns,
			});
			const header = [statusLine(detail, result.durationMs), resolved.note ? `(${resolved.note})` : ""]
				.filter(Boolean)
				.join(" ");
			return {
				content: [
					{ type: "text" as const, text: header },
					{ type: "text" as const, text: result.message },
				],
				details: detail,
			};
		});
		job.promise = promise;
		// A job nobody waits on finishes into the transcript as a follow-up.
		if (job.status === "running" && !job.awaiting) {
			void promise.then((result) => {
				if (job.awaiting) return;
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
				pi.sendMessage(
					{ customType: "reef-task-finished", content: text, display: true, details: result.details },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			});
		}
		return { id, promise, state };
	};

	pi.registerTool({
		name: "task",
		label: "Delegate to a subagent",
		description: `Delegate a self-contained job to a subagent, either \`${BUILTIN_AGENTS.map((entry) => entry.name).join("`, `")}\` or a definition from .reef/agents.

The subagent gets a specification, never this conversation: \`prompt\` is the job, \`context\` is the facts it needs. Keep \`context\` under 2k tokens and curated — it is the difference between a useful subagent and an expensive one.

Foreground by default. Pass \`background: true\` to get a task id immediately and a message when it finishes.`,
		parameters: Type.Object({
			prompt: Type.String({ description: "The job, one paragraph, outcome-shaped" }),
			subagent_type: Type.Optional(Type.String({ description: "Definition name, e.g. explorer, reviewer, scout" })),
			description: Type.Optional(Type.String({ description: "Short label for the list and the status line" })),
			context: Type.Optional(Type.String({ description: "Facts the subagent needs, under 2k tokens, curated by you" })),
			constraints: Type.Optional(Type.Array(Type.String(), { description: "Rules the subagent must respect" })),
			done_when: Type.Optional(Type.Array(Type.String(), { description: "Checkable conditions for success" })),
			return_format: Type.Optional(
				Type.Union([Type.Literal("summary"), Type.Literal("patch"), Type.Literal("findings"), Type.Literal("json")]),
			),
			model: Type.Optional(Type.String({ description: "Override the definition's model" })),
			background: Type.Optional(Type.Boolean({ description: "Return a task id immediately" })),
		}),
		defaultActive: false,
		execute: async (toolCallId, args, _signal, onUpdate, ctx) => {
			const started = start(args, ctx, toolCallId, (text) =>
				onUpdate?.({ content: [{ type: "text", text }], details: undefined as unknown as TaskDetail }),
			);
			if ("error" in started) {
				return {
					content: [{ type: "text" as const, text: started.error }],
					isError: true,
					details: { taskId: "", subagent: args.subagent_type ?? "", status: "failed" } as TaskDetail,
				};
			}
			if (args.background) {
				const job = getJob<TaskDetail>(started.id);
				if (job) job.awaiting = false;
				return {
					content: [
						{
							type: "text" as const,
							text: `${statusLine({ taskId: started.id, subagent: started.state.definition.name, status: "running" })} — you will get a message when it finishes, or call task_output.`,
						},
					],
					details: { taskId: started.id, subagent: started.state.definition.name, status: "running" } as TaskDetail,
				};
			}
			const job = getJob<TaskDetail>(started.id);
			if (job) job.awaiting = true;
			return started.promise;
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Read subagent output",
		description: "Read a subagent's result. Blocks until it finishes unless `block` is false.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The id `task` returned" }),
			block: Type.Optional(Type.Boolean({ description: "Wait for completion (default true)" })),
		}),
		defaultActive: false,
		execute: async (_toolCallId, args) => {
			const job = getJob<TaskDetail>(String(args.task_id));
			if (!job) {
				const known = listJobs().map((entry) => entry.id).join(", ") || "none";
				return {
					content: [{ type: "text" as const, text: `No task \`${args.task_id}\`. Known: ${known}` }],
					isError: true,
					details: { taskId: String(args.task_id), subagent: "", status: "failed" } as TaskDetail,
				};
			}
			job.awaiting = args.block !== false;
			return job.promise;
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop a subagent",
		description: "Stop a running subagent.",
		parameters: Type.Object({ task_id: Type.String() }),
		defaultActive: false,
		execute: async (_toolCallId, args) => {
			const job = getJob<TaskDetail>(String(args.task_id));
			if (!job) {
				return {
					content: [{ type: "text" as const, text: `No task \`${args.task_id}\`.` }],
					isError: true,
					details: { taskId: String(args.task_id), subagent: "", status: "failed" } as TaskDetail,
				};
			}
			job.abort.abort();
			return {
				content: [{ type: "text" as const, text: `Stopping ${job.id}.` }],
				details: { taskId: job.id, subagent: "", status: "killed" } as TaskDetail,
			};
		},
	});

	pi.registerCommand("agents", {
		description: "List the subagents available here",
		handler: async (_args: string, ctx) => {
			const definitions = listFor(ctx.cwd);
			const lines = definitions.map((entry) => `${entry.name.padEnd(12)} ${entry.description}`);
			const tools = definitions.map((entry) => `${entry.name}: ${toolsFor(entry).join(", ")}`);
			ctx.ui?.notify?.([...lines, "", ...tools].join("\n"));
		},
	});

	pi.registerCommand("tasks", {
		description: "List this session's subagent tasks",
		handler: async (_args: string, ctx) => {
			const jobs = listJobs();
			if (jobs.length === 0) {
				ctx.ui?.notify?.("No tasks yet.");
				return;
			}
			const lines = jobs.map((job) => {
				const state = tasks.get(job.id);
				const duration = (job.finishedAt ?? Date.now()) - job.startedAt;
				return `${job.id}  ${(state?.definition.name ?? "?").padEnd(10)} ${job.status.padEnd(11)} ${formatDuration(duration)}`;
			});
			ctx.ui?.notify?.(lines.join("\n"));
		},
	});
}

export function createTasksExtension(): ExtensionFactory {
	return (pi) => {
		// Tasks are process-local like script jobs; a resumed session has no child processes.
		pi.on("session_start", async (event) => {
			if (event.reason === "startup" || event.reason === "new") return undefined;
			for (const job of listJobs()) {
				if (job.status !== "running") continue;
				job.status = "interrupted";
				job.finishedAt = Date.now();
				pi.appendEntry(SCRIPT_JOB_ENTRY_TYPE, toEntryData(job));
			}
			return undefined;
		});
		registerTaskTools(pi);
	};
}

export default createTasksExtension();
