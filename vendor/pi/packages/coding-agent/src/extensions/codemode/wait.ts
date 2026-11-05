/**
 * `wait_for_script`: the declared partner of `script`.
 *
 * A background script starts, the model gets a job id, and this tool decides when the model looks
 * again. Three actions: `wait` (default) blocks until the run ends or the window closes, `status`
 * reports without blocking, `kill` aborts.
 *
 * Waiting is bounded on purpose. A closed window returns the partial output and the job id, so the
 * model can keep working and come back, instead of the whole turn stalling on one long script.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { formatBytes, formatDuration, getJob, SCRIPT_JOB_ENTRY_TYPE, listJobs } from "./jobs.ts";

export const waitForScriptSchema = Type.Object({
	toolCallId: Type.String({
		description: "Job id returned by `script` when the source asked for `startInBackground`.",
	}),
	action: Type.Optional(
		Type.Union([Type.Literal("wait"), Type.Literal("status"), Type.Literal("kill")], {
			description: "`wait` (default) blocks until the run ends or the window closes. `status` returns now. `kill` aborts the run.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({
			description: "How long `wait` may block, in milliseconds. Default 120000. Clamped to 600000.",
		}),
	),
});

export type WaitForScriptInput = Static<typeof waitForScriptSchema>;

const DEFAULT_WAIT_MS = 120_000;
const MAX_WAIT_MS = 600_000;

function text(value: string) {
	return { type: "text" as const, text: value };
}

function statusLine(job: ReturnType<typeof getJob>): string {
	if (!job) return "[Script unknown · no job with that id]";
	const elapsed = formatDuration((job.finishedAt ?? Date.now()) - job.startedAt);
	const calls = `${job.calls} ${job.calls === 1 ? "call" : "calls"}`;
	switch (job.status) {
		case "running":
			return `[Script running · ${calls} · ${elapsed}]`;
		case "done":
			return `[Script completed · ${calls} · ${elapsed}]`;
		case "failed":
			return `[Script failed · ${calls} · ${elapsed}]`;
		case "killed":
			return `[Script killed · ${calls} · ${elapsed}]`;
		case "interrupted":
			return `[Script interrupted · ${calls} · ${elapsed} · the process that ran it is gone]`;
	}
}

function resultText(result: { content?: readonly unknown[] }): string {
	return (result.content ?? [])
		.map((item) =>
			typeof item === "object" && item !== null && "text" in item ? String((item as { text: unknown }).text) : "",
		)
		.join("\n")
		.trim();
}

export function createWaitForScriptToolDefinition(): ToolDefinition<typeof waitForScriptSchema> {
	return {
		name: "wait_for_script",
		label: "wait_for_script",
		description: `Wait on a background script started with \`// @script: {"startInBackground": true}\`.

- \`{ toolCallId }\` waits up to \`timeout_ms\` (default 120000, max 600000) for the run to end, then returns its full result. If the window closes first you get the partial output and the same job id: wait again rather than restarting the script.
- \`{ toolCallId, action: "status" }\` returns the status line now, for a run you do not want to block on.
- \`{ toolCallId, action: "kill" }\` aborts the run. Calls already finished keep their effects.

A script left running when the turn ends keeps running; its result arrives as a follow-up message.`,
		promptSnippet: "Wait for, poll, or kill a background script",
		promptGuidelines: [
			"Only use `wait_for_script` after a `script` call that returned a job id. A script you awaited directly has already finished.",
		],
		parameters: waitForScriptSchema,
		defaultActive: true,
		exposure: "model-only",
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = getJob(params.toolCallId);
			if (!job) {
				const running = listJobs().filter((entry) => entry.status === "running");
				const hint =
					running.length === 0
						? " No background script is running."
						: ` Running: ${running.map((entry) => entry.id).join(", ")}.`;
				return { content: [text(`[Script unknown · no job with id "${params.toolCallId}"]${hint}`)], details: undefined, isError: true };
			}
			const action = params.action ?? "wait";

			if (action === "status") {
				return { content: [text(statusLine(job))], details: undefined };
			}
			if (action === "kill") {
				job.abort.abort(new Error("Killed by wait_for_script"));
				return { content: [text(`${statusLine(job)}\n\nThe run was aborted. Calls already finished keep their effects.`)], details: undefined };
			}

			const timeoutMs = Math.min(Math.max(params.timeout_ms ?? DEFAULT_WAIT_MS, 1), MAX_WAIT_MS);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const closed = new Promise<"window">((resolve) => {
				timer = setTimeout(() => resolve("window"), timeoutMs);
			});
			job.awaiting = true;
			let outcome: "finished" | "window";
			try {
				outcome = await Promise.race([job.promise.then(() => "finished" as const), closed]);
			} finally {
				if (timer) clearTimeout(timer);
				job.awaiting = false;
			}
			if (outcome === "window") {
				return {
					content: [
						text(
							`${statusLine(job)}\n\nThe wait window closed before the run ended. It is still running as ${job.id}: call \`wait_for_script\` again, or \`{ action: "kill" }\` to stop it.`,
						),
					],
					details: undefined,
				};
			}
			const result = await job.promise;
			const body = resultText(result);
			const calls = job.calls;
			const header = `${statusLine(job).slice(0, -1)} · ${calls === 1 ? "1 call" : `${calls} calls`}]`;
			const passthrough = (result as { details?: { passthroughBytes?: number } }).details?.passthroughBytes;
			const size = typeof passthrough === "number" ? ` · ${formatBytes(passthrough)} passed through unfiltered` : "";
			return {
				content: [text(`${header.replace("]", `${size}]`)}\n\n${body.replace(/^\[[^\]]*\]\n*/, "")}`.trim())],
				details: result.details,
				isError: result.isError === true,
			};
		},
	};
}
