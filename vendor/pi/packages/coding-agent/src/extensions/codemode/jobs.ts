/**
 * Background script jobs. A `script` call whose source carries
 * `// @script: {"startInBackground": true}` returns as soon as it starts, and the run continues
 * under an id that `wait_for_script` can wait on, poll, or kill.
 *
 * The registry is process-local and in memory. Runs are also written to the session as
 * `script-job` custom entries, so a resumed session can report a job as `interrupted` instead of
 * pretending it is still running.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CodemodeNestedCall } from "./tool.ts";

export type ScriptJobStatus = "running" | "done" | "failed" | "killed" | "interrupted";

export interface ScriptJobDetail {
	calls: CodemodeNestedCall[];
	fullOutputPath?: string;
}

export interface ScriptJob {
	id: string;
	/** The tool call that started it, so a resumed session can match it. */
	sourceToolCallId: string;
	startedAt: number;
	finishedAt?: number;
	status: ScriptJobStatus;
	/** Number of nested calls issued so far. */
	calls: number;
	/** Whether a caller is already waiting, so completion does not need a wake message. */
	awaiting: boolean;
	promise: Promise<AgentToolResult<ScriptJobDetail>>;
	abort: AbortController;
}

/** Session custom-entry type holding one job's start and finish. */
export const SCRIPT_JOB_ENTRY_TYPE = "script-job";

export interface ScriptJobEntryData {
	id: string;
	sourceToolCallId: string;
	status: ScriptJobStatus;
	startedAt: number;
	finishedAt?: number;
	calls: number;
}

const jobs = new Map<string, ScriptJob>();
let counter = 0;

export function newJobId(): string {
	counter += 1;
	return `job-${counter}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createJob(id: string, sourceToolCallId: string, abort: AbortController): ScriptJob {
	const job: ScriptJob = {
		id,
		sourceToolCallId,
		startedAt: Date.now(),
		status: "running",
		calls: 0,
		awaiting: false,
		promise: Promise.resolve({ content: [], details: { calls: [] } }),
		abort,
	};
	jobs.set(id, job);
	return job;
}

export function getJob(id: string): ScriptJob | undefined {
	return jobs.get(id);
}

export function listJobs(): ScriptJob[] {
	return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function runningJobs(): ScriptJob[] {
	return listJobs().filter((job) => job.status === "running");
}

export function finishJob(job: ScriptJob, status: ScriptJobStatus): void {
	if (job.status !== "running") return;
	job.status = status;
	job.finishedAt = Date.now();
}

/** Mark every job as interrupted. Called when a session is resumed: the process that ran them is gone. */
export function markInterrupted(): ScriptJobEntryData[] {
	const interrupted: ScriptJobEntryData[] = [];
	for (const job of jobs.values()) {
		if (job.status !== "running") continue;
		job.status = "interrupted";
		job.finishedAt = Date.now();
		interrupted.push(toEntryData(job));
	}
	return interrupted;
}

export function toEntryData(job: ScriptJob): ScriptJobEntryData {
	return {
		id: job.id,
		sourceToolCallId: job.sourceToolCallId,
		status: job.status,
		startedAt: job.startedAt,
		...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
		calls: job.calls,
	};
}

/** `4.2s`, `1m 03s`, `2h 07m`. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 100) / 10);
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.round(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `512 B`, `12.3 KiB`, `1.4 MiB`, for the "passed through unfiltered" figure. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
