/**
 * `reef doctor` — the checks that answer "will this install work?", without spending a token.
 *
 * `/doctor` inside a session answers the same question with the session's own model and settings.
 * This exists because the first thing a user does after `npm i -g` is type a command at a shell, and
 * a bare word is a message: without this, `reef doctor` costs money and gets an answer the model
 * guessed at from the filesystem. Every check below is measured here.
 *
 * Exit codes: 0 all clear, 1 something that will stop work.
 */

import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "../core/model-runtime.ts";
import { loadPolicy } from "../extensions/safety/policy.ts";
import { APP_NAME, getAgentDir, getPackageDir, getQuickJSWasmPath, PACKAGE_NAME, VERSION } from "../config.ts";

export interface DoctorLine {
	label: string;
	ok: boolean | undefined;
	detail: string;
}

export function formatDoctor(lines: readonly DoctorLine[]): string {
	const width = Math.max(...lines.map((line) => line.label.length));
	const body = lines
		.map((line) => {
			const mark = line.ok === undefined ? "?" : line.ok ? "✓" : "!";
			return `  ${mark} ${line.label.padEnd(width)}  ${line.detail}`;
		})
		.join("\n");
	const failing = lines.filter((line) => line.ok === false).length;
	const footer = failing === 0 ? "All checks passed." : `${failing} failing — see above.`;
	return `${body}\n\n${footer}`;
}

export async function collectDoctorLines(cwd: string): Promise<DoctorLine[]> {
	const lines: DoctorLine[] = [];

	lines.push({
		label: "reef",
		ok: true,
		detail: `${VERSION}  (${PACKAGE_NAME} in ${getPackageDir()})`,
	});

	const major = Number(process.versions.node.split(".")[0]);
	lines.push({
		label: "node",
		ok: major >= 22,
		detail: `v${process.versions.node}${major >= 22 ? "" : " — REEF needs 22 or newer"}`,
	});

	const cliPath = join(getPackageDir(), "dist", "bundle", "cli.js");
	lines.push({
		label: "bundle",
		ok: existsSync(cliPath),
		detail: existsSync(cliPath) ? "dist/bundle complete" : `missing ${cliPath} — reinstall`,
	});

	// The failure that actually stops work is a sandbox that cannot start: every tool call goes
	// through it, so name the missing asset instead of failing at the first `script`.
	let engine: string;
	let engineOk: boolean;
	try {
		const wasm = getQuickJSWasmPath();
		engineOk = existsSync(wasm);
		engine = engineOk ? `quickjs-wasm ${wasm}` : `cannot find ${wasm} — reinstall, or npm i quickjs-wasi`;
	} catch {
		engineOk = false;
		engine = "quickjs-wasi is not installed — the script tool cannot start";
	}
	lines.push({ label: "script engine", ok: engineOk, detail: engine });

	const agentDir = getAgentDir();
	let configOk = true;
	try {
		mkdirSync(agentDir, { recursive: true });
		accessSync(agentDir, constants.W_OK);
	} catch {
		configOk = false;
	}
	lines.push({
		label: "config",
		ok: configOk,
		detail: configOk ? `${agentDir} writable` : `${agentDir} is not writable`,
	});

	try {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: AbortSignal.timeout(10_000) });
		const models = runtime.getAvailableSnapshot();
		const providers = [...new Set(models.map((model) => model.provider))];
		lines.push({
			label: "models",
			ok: models.length > 0,
			detail:
				models.length > 0
					? `${models.length} available across ${providers.join(", ") || "no provider"}`
					: `none available — ${APP_NAME} auth login, or set a provider API key`,
		});
	} catch (error) {
		lines.push({
			label: "models",
			ok: undefined,
			detail: `could not read model catalogs: ${error instanceof Error ? error.message : String(error)}`,
		});
	}

	try {
		const policy = loadPolicy({ cwd, agentDir });
		lines.push({
			label: "policy",
			ok: policy.problems.length === 0,
			detail:
				policy.problems.length > 0
					? `${policy.problems.length} problem(s): ${policy.problems[0]}`
					: `${policy.rules.length} rules${policy.sources.length > 0 ? ` from ${policy.sources.length} file(s)` : ", builtin only"}`,
		});
	} catch (error) {
		lines.push({
			label: "policy",
			ok: false,
			detail: error instanceof Error ? error.message : String(error),
		});
	}

	return lines;
}

/** Handles `reef doctor [--json]`. Returns handled=false for anything else. */
export async function runDoctorCommand(
	args: string[],
): Promise<{ handled: boolean; exitCode?: number }> {
	const words = args.filter((arg) => !arg.startsWith("-"));
	if (words[0] !== "doctor") return { handled: false };
	const unknown = args.find((arg) => !["doctor", "--json"].includes(arg));
	if (unknown) {
		console.error(`Unknown option ${unknown} for "${APP_NAME} doctor".`);
		return { handled: true, exitCode: 2 };
	}

	const lines = await collectDoctorLines(process.cwd());
	const failing = lines.some((line) => line.ok === false);
	if (args.includes("--json")) {
		process.stdout.write(`${JSON.stringify({ ok: !failing, checks: lines }, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatDoctor(lines)}\n`);
	}
	return { handled: true, exitCode: failing ? 1 : 0 };
}
