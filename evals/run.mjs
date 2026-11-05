#!/usr/bin/env node
/**
 * The eval harness: `micro`, `real`, `adversarial`.
 *
 *   node evals/run.mjs --suite micro --repeat 3
 *   node evals/run.mjs --suite micro --script off        # direct-tool baseline
 *   node evals/run.mjs --suite adversarial --tier medium
 *
 * Each scenario runs in a throwaway copy of `evals/fixture`, so a suite that edits files cannot
 * influence the next run. Grading is by predicate — the answer must contain, must match, must not
 * contain, or the files must end up in a given state. No judge model, so the run is cheap and the
 * result means the same thing tomorrow.
 */

import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newestSession, readEntries, summarize } from "./lib/session.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const reef = join(here, "..", "apps", "reef", "bin", "reef");
const fixture = join(here, "fixture");

function parseArgs() {
	const out = { suite: "micro", repeat: 1, script: "on", tier: "medium", model: undefined, quiet: false };
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--suite") out.suite = argv[++i];
		else if (arg === "--repeat") out.repeat = Number(argv[++i]);
		else if (arg === "--script") out.script = argv[++i];
		else if (arg === "--tier") out.tier = argv[++i];
		else if (arg === "--model") out.model = argv[++i];
		else if (arg === "--quiet") out.quiet = true;
	}
	return out;
}

/** Grade one answer against the scenario's predicate. Returns the first reason it failed. */
export function grade(scenario, answer, work) {
	const expect = scenario.expect ?? {};
	for (const needle of expect.contains ?? []) {
		if (!answer.toLowerCase().includes(String(needle).toLowerCase())) return `missing "${needle}"`;
	}
	for (const pattern of expect.regex ?? []) {
		if (!new RegExp(pattern, "i").test(answer)) return `no match for /${pattern}/`;
	}
	for (const needle of expect.not_contains ?? []) {
		if (answer.toLowerCase().includes(String(needle).toLowerCase())) return `should not contain "${needle}"`;
	}
	for (const file of expect.unchanged ?? []) {
		const original = join(fixture, file);
		const current = join(work, file);
		if (!existsSync(current) || !existsSync(original)) continue;
		if (readFileSync(original, "utf8") !== readFileSync(current, "utf8")) return `${file} was modified`;
	}
	if (expect.json) {
		const path = join(work, expect.json.path);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed[expect.json.field] !== expect.json.value) return `${expect.json.field} is not ${JSON.stringify(expect.json.value)}`;
		} catch {
			return `${expect.json.path} is not valid JSON`;
		}
	}
	if (expect.json_path && !existsSync(join(work, expect.json_path))) return `${expect.json_path} does not exist`;
	if (expect.file_contains) {
		const path = join(work, expect.file_contains.path);
		const text = existsSync(path) ? readFileSync(path, "utf8") : "";
		if (!expect.file_contains.any.some((needle) => text.includes(needle))) {
			return `${expect.file_contains.path} has none of ${expect.file_contains.any.join(", ")}`;
		}
	}
	return undefined;
}

function runOne(scenario, options) {
	const work = mkdtempSync(join(tmpdir(), `reef-${scenario.id}-`));
	cpSync(fixture, work, { recursive: true });
	const sessionDir = join(work, ".reef-eval", "sessions");
	mkdirSync(sessionDir, { recursive: true });

	const argv = [reef, "-p", scenario.task, "--session-dir", sessionDir];
	if (options.model) argv.push("--model", options.model);
	const env = {
		...process.env,
		REEF_TIER: options.tier,
		...(options.script === "off" ? { REEF_SCRIPT: "off" } : {}),
	};

	const startedAt = Date.now();
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { cwd: work, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (exitCode) => {
			const session = newestSession(sessionDir);
			const summary = session
				? summarize(readEntries(session))
				: { parentTokens: 0, delegatedTokens: 0, totalTokens: 0, totalCost: 0, requests: 0, delegated: { tasks: 0 } };
			const answer = stdout.trim();
			const failure = grade(scenario, answer, work);
			rmSync(work, { recursive: true, force: true });
			resolve({
				id: scenario.id,
				pass: failure === undefined,
				failure,
				exitCode,
				answer: answer.split("\n").filter(Boolean).slice(-1)[0] ?? "",
				stderr: stderr.trim().slice(0, 300),
				durationMs: Date.now() - startedAt,
				...summary,
			});
		});
	});
}

async function main() {
	const options = parseArgs();
	const suite = JSON.parse(readFileSync(join(here, "scenarios", `${options.suite}.json`), "utf8"));
	const runs = [];
	for (let round = 0; round < options.repeat; round += 1) {
		for (const scenario of suite.scenarios) {
			const run = await runOne(scenario, options);
			if (!options.quiet) {
				const mark = run.pass ? "pass" : `FAIL ${run.failure}`;
				process.stderr.write(
					`${run.id.padEnd(18)} ${mark.padEnd(28)} ${String(run.parentTokens).padStart(7)} tok · $${run.totalCost.toFixed(4)} · ${(run.durationMs / 1000).toFixed(1)}s\n`,
				);
			}
			runs.push(run);
		}
	}

	const passed = runs.filter((run) => run.pass).length;
	const report = {
		suite: suite.suite,
		config: { script: options.script, tier: options.tier, model: options.model ?? "configured default", repeat: options.repeat },
		passRate: runs.length === 0 ? 0 : Number((passed / runs.length).toFixed(3)),
		passed,
		total: runs.length,
		tokensPerTask: runs.length === 0 ? 0 : Math.round(runs.reduce((sum, run) => sum + run.totalTokens, 0) / runs.length),
		requestsPerTask: runs.length === 0 ? 0 : Number((runs.reduce((sum, run) => sum + run.requests, 0) / runs.length).toFixed(2)),
		costTotal: Number(runs.reduce((sum, run) => sum + run.totalCost, 0).toFixed(4)),
		failures: runs.filter((run) => !run.pass).map((run) => ({ id: run.id, reason: run.failure, answer: run.answer.slice(0, 200) })),
		runs,
		generatedAt: new Date().toISOString(),
	};

	mkdirSync(join(here, "reports"), { recursive: true });
	const stamp = `${suite.suite}${options.script === "off" ? "-noscript" : ""}-${Date.now()}`;
	const out = join(here, "reports", `${stamp}.json`);
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(here, "reports", "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

	process.stderr.write(
		`\n${report.suite}: ${passed}/${runs.length} (${(report.passRate * 100).toFixed(0)}%) · ${report.tokensPerTask} tok/task · ${report.requestsPerTask} req/task · $${report.costTotal}\n`,
	);
	process.stderr.write(`report: ${out}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("run.mjs")) await main();
