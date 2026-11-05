/**
 * `/doctor` — is this install able to do the thing?
 *
 * Every check answers a question a user would otherwise ask on a bug report: is a model configured,
 * does it have credentials, did a policy file fail to load, is the script engine on, is the request
 * still append-only. It reports what it measured and never guesses: a check that cannot run says so.
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import { loadPolicy } from "../safety/policy.ts";

export interface Check {
	name: string;
	ok: boolean | undefined;
	detail: string;
}

/** Format for the dialog: one line per check, failures first is the reader's job, not ours. */
export function formatChecks(checks: readonly Check[]): string {
	const lines = checks.map((check) => {
		const mark = check.ok === undefined ? "?" : check.ok ? "✓" : "!";
		return `${mark} ${check.name.padEnd(18)} ${check.detail}`;
	});
	const failed = checks.filter((check) => check.ok === false).length;
	const unknown = checks.filter((check) => check.ok === undefined).length;
	lines.push("");
	lines.push(
		failed === 0 && unknown === 0
			? `All ${checks.length} checks passed.`
			: `${checks.length} checks · ${failed} failing · ${unknown} unknown`,
	);
	return lines.join("\n");
}

function writable(path: string): boolean {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

export function createDoctorExtension(): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerCommand("doctor", {
			description: "Check the model, credentials, policy, script engine, and cache contract",
			handler: async (_args: string, ctx: ExtensionCommandContext) => {
				const checks: Check[] = [];
				const settings = pi.getSettings();

				const model = ctx.model;
				checks.push({
					name: "model",
					ok: model ? true : false,
					detail: model ? `${model.provider}/${model.id}` : "none selected: /model picks one",
				});

				if (model) {
					const authed = ctx.modelRegistry.hasConfiguredAuth(model);
					checks.push({
						name: "credentials",
						ok: authed,
						detail: authed ? "configured" : `no key for ${model.provider}: reef auth login ${model.provider}`,
					});
				}

				const tier = settings.safety?.tier ?? SETTINGS_DEFAULTS.safety.tier;
				checks.push({
					name: "safety tier",
					ok: true,
					detail: `${tier}${process.env.REEF_READ_ONLY === "1" ? " (read-only via env)" : ""}`,
				});

				const policy = loadPolicy({ cwd: ctx.cwd });
				checks.push({
					name: "policy files",
					ok: policy.problems.length === 0,
					detail:
						policy.problems.length === 0
							? `${policy.rules.length} rule(s) from ${policy.sources.length} file(s)`
							: policy.problems.join("; "),
				});

				const active = pi.getActiveTools();
				const facts = (
					ctx as unknown as { getSectionBudget?: () => { tokens: number } | undefined }
				).getSectionBudget?.();
				checks.push({
					name: "declared tools",
					ok: active.length > 0,
					detail: active.length > 0 ? `${active.join(", ")}${facts ? ` · ~${facts.tokens} tok` : ""}` : "none active",
				});

				const scriptEnabled = process.env.REEF_SCRIPT !== "off" && settings.script?.enabled !== false;
				checks.push({
					name: "script engine",
					ok: true,
					detail: scriptEnabled ? "on" : "off (script.enabled): tools are declared directly",
				});

				const sessionDir = join(ctx.cwd, ".reef");
				checks.push({
					name: "workspace",
					ok: writable(ctx.cwd),
					detail: writable(ctx.cwd) ? `${ctx.cwd} (state in ${sessionDir})` : `${ctx.cwd} is not writable`,
				});

				const audits = ctx.getRequestAudits();
				const last = audits[audits.length - 1];
				checks.push({
					name: "cache contract",
					ok: last ? last.appendOnly : undefined,
					detail: last
						? last.appendOnly
							? `append-only · ${last.cacheablePrefixTokens} tok reused`
							: `broke: ${last.breakReason ?? last.violations[0] ?? "unexpected"}`
						: "no request yet",
				});

				const unknownCount = checks.filter((check) => check.ok === undefined).length;
				const failed = checks.filter((check) => check.ok === false).length;
				ctx.ui?.notify?.(formatChecks(checks));
				// A command cannot set an exit code, but it can say which way the answer went.
				if (failed > 0) process.env.REEF_DOCTOR_FAILED = "1";
				else delete process.env.REEF_DOCTOR_FAILED;
				if (unknownCount > 0) process.env.REEF_DOCTOR_UNKNOWN = "1";
			},
		});
	};
}

export default createDoctorExtension();
