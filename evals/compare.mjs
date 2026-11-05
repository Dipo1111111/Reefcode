#!/usr/bin/env node
/**
 * Compare two delegation reports (solo vs delegate) without spending anything.
 *
 *   node evals/compare.mjs evals/reports/a.json evals/reports/b.json
 *
 * Means are per task, so the two sides never need the same number of runs. A scenario that delegated
 * nothing is reported separately: it is not evidence either way.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [soloPath, delegatePath] = process.argv.slice(2);
if (!soloPath || !delegatePath) {
	console.error("usage: node evals/compare.mjs <solo-report.json> <delegate-report.json>");
	process.exit(64);
}

const solo = JSON.parse(readFileSync(soloPath, "utf8"));
const delegate = JSON.parse(readFileSync(delegatePath, "utf8"));

const mean = (runs, pick) => (runs.length === 0 ? 0 : runs.reduce((sum, run) => sum + pick(run), 0) / runs.length);
const round = (value) => Math.round(value * 10) / 10;

const soloRuns = solo.runs;
const delegateRuns = delegate.runs;
const delegatedRuns = delegateRuns.filter((run) => run.delegated.tasks > 0);

const soloTokens = mean(soloRuns, (run) => run.totalTokens);
const delegateTokens = mean(delegatedRuns, (run) => run.totalTokens);
const soloParent = mean(soloRuns, (run) => run.parentTokens);
const delegateParent = mean(delegatedRuns, (run) => run.parentTokens);
const reduction = soloTokens === 0 ? 0 : ((soloTokens - delegateTokens) / soloTokens) * 100;

const perScenario = soloRuns.map((run) => {
	const other = delegateRuns.find((entry) => entry.id === run.id);
	return {
		id: run.id,
		soloTokens: run.totalTokens,
		delegateTokens: other?.totalTokens ?? 0,
		delegated: (other?.delegated.tasks ?? 0) > 0,
		changePercent: other && run.totalTokens > 0 ? round(((other.totalTokens - run.totalTokens) / run.totalTokens) * 100) : 0,
	};
});

const report = {
	model: delegateRuns[0]?.answer ? undefined : undefined,
	runs: { solo: soloRuns.length, delegate: delegateRuns.length, delegatedOnly: delegatedRuns.length },
	tokensPerTask: { solo: Math.round(soloTokens), delegate: Math.round(delegateTokens), reductionPercent: round(reduction) },
	parentTokensPerTask: {
		solo: Math.round(soloParent),
		delegate: Math.round(delegateParent),
		reductionPercent: round(soloParent === 0 ? 0 : ((soloParent - delegateParent) / soloParent) * 100),
	},
	perScenario,
	killCriterion: {
		threshold: "10% reduction in tokens per task",
		result: reduction >= 10 ? "pass" : "fail — ship explorer only",
		note:
			delegateRuns.length - delegatedRuns.length > 0
				? `${delegateRuns.length - delegatedRuns.length} run(s) never delegated; excluded from the delegate mean`
				: "every delegate run used a subagent",
	},
	generatedAt: new Date().toISOString(),
};

const out = join(here, "reports", "delegation-comparison.json");
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\nreport: ${out}`);
