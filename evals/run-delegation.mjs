#!/usr/bin/env node
/**
 * Delegation eval: tokens per task, delegated vs solo.
 *
 *   node evals/run-delegation.mjs --mode delegate --repeat 1
 *   node evals/run-delegation.mjs --compare
 *
 * Runs each scenario in a throwaway copy of `evals/fixture`, reads the session file afterwards, and
 * totals parent and subagent tokens separately. `--compare` runs both modes and prints the reduction,
 * which is what the Phase 3 kill criterion is measured against.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newestSession, readEntries, summarize } from "./lib/session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const reef = join(here, "..", "apps", "reef", "bin", "reef");
const fixture = join(here, "fixture");

function args() {
	const out = { mode: "delegate", repeat: 1, compare: false, model: undefined };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--compare") out.compare = true;
		else if (arg === "--mode") out.mode = argv[++i];
		else if (arg === "--repeat") out.repeat = Number(argv[++i]);
		else if (arg === "--model") out.model = argv[++i];
	}
	return out;
}

/** One run in an isolated copy, so sessions and artifacts never mix between scenarios. */
function runOne(scenario, mode, model) {
	const work = mkdtempSync(join(tmpdir(), `reef-eval-${scenario.id}-`));
	cpSync(fixture, work, { recursive: true });
	const sessionDir = join(work, ".reef-eval", "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const prompt = mode === "delegate" ? `${scenario.task}\n\n${scenario.hint}` : scenario.task;
	const argv = [reef, "-p", prompt, "--session-dir", sessionDir];
	if (model) argv.push("--model", model);

	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (exitCode) => {
			const session = newestSession(sessionDir);
			const summary = session
				? summarize(readEntries(session))
				: { parentTokens: 0, delegatedTokens: 0, totalTokens: 0, totalCost: 0, delegated: { tasks: 0 } };
			rmSync(work, { recursive: true, force: true });
			resolve({
				id: scenario.id,
				mode,
				exitCode,
				answer: stdout.trim().split("\n").slice(-1)[0] ?? "",
				stderr: stderr.trim().slice(0, 200),
				durationMs: Date.now() - startedAt,
				...summary,
			});
		});
	});
}

async function main() {
	const options = args();
	const suite = JSON.parse(readFileSync(join(here, "scenarios", "delegation.json"), "utf8"));
	const modes = options.compare ? ["solo", "delegate"] : [options.mode];

	const runs = [];
	for (const mode of modes) {
		for (let round = 0; round < options.repeat; round += 1) {
			for (const scenario of suite.scenarios) {
				const run = await runOne(scenario, mode, options.model);
				process.stderr.write(
					`${run.id} [${mode}] ${run.parentTokens} parent / ${run.delegatedTokens} delegated tokens · $${run.totalCost.toFixed(4)} · ${(run.durationMs / 1000).toFixed(1)}s\n`,
				);
				runs.push(run);
			}
		}
	}

	const report = { suite: suite.suite, runs, generatedAt: new Date().toISOString() };
	if (options.compare) {
		const mean = (mode) => {
			const selected = runs.filter((run) => run.mode === mode);
			const total = selected.reduce((sum, run) => sum + run.totalTokens, 0);
			return total / Math.max(1, selected.length);
		};
		const parentMean = (mode) => {
			const selected = runs.filter((run) => run.mode === mode);
			return selected.reduce((sum, run) => sum + run.parentTokens, 0) / Math.max(1, selected.length);
		};
		const solo = mean("solo");
		const delegated = mean("delegate");
		report.comparison = {
			soloTokensPerTask: Math.round(solo),
			delegateTokensPerTask: Math.round(delegated),
			reductionPercent: solo === 0 ? 0 : Number((((solo - delegated) / solo) * 100).toFixed(1)),
			soloParentPerTask: Math.round(parentMean("solo")),
			delegateParentPerTask: Math.round(parentMean("delegate")),
			killCriterion: solo === 0 ? "not measured" : (solo - delegated) / solo >= 0.1 ? "pass" : "fail — ship explorer only",
		};
		process.stderr.write(`\n${JSON.stringify(report.comparison, null, 2)}\n`);
	}

	mkdirSync(join(here, "reports"), { recursive: true });
	const out = join(here, "reports", `delegation-${Date.now()}.json`);
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	process.stderr.write(`\nreport: ${out}\n`);
}

await main();
