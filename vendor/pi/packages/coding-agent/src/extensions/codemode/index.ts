/**
 * The `codemode` tool as an extension. The CLI loads it as a built-in extension; SDK users
 * add `createCodemodeExtension()` to their extension factories.
 *
 * `codemode` is registered inactive. Activate it with `--tools`, the `defaultTools` setting, or
 * `setActiveTools()`; the MCP extension activates it when MCP tools are only reachable from scripts.
 */

import type { ExtensionAPI, ExtensionFactory } from "../../core/extensions/types.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { createCodemodeToolDefinition } from "./tool.ts";
import { createWaitForScriptToolDefinition } from "./wait.ts";
import { markInterrupted, SCRIPT_JOB_ENTRY_TYPE } from "./jobs.ts";

export interface CodemodeExtensionOptions {
	/** Overrides the `codemode.mode` setting. */
	mode?: CodemodeMode;
	/** Overrides the `codemode.inlineBudget` setting. */
	inlineBudget?: number;
	/** Expose the model catalog and classifiers to scripts as `models`. Default: `true`. */
	models?: boolean;
}

function readMode(pi: ExtensionAPI): CodemodeMode {
	return pi.getSettings().codemode?.mode === "only" ? "only" : SETTINGS_DEFAULTS.codemode.mode;
}

/**
 * `script.enabled` (ADR-014) or `REEF_SCRIPT=off`. When off, the script tools are not declared and
 * every tool is declared directly, which is the direct-tool baseline the evals measure against.
 */
function readEnvEnabled(): boolean | undefined {
	const env = process.env.REEF_SCRIPT?.trim().toLowerCase();
	if (env === undefined || env === "") return undefined;
	return !(env === "off" || env === "false" || env === "0");
}

/**
 * Settings are not readable while extensions load, so this is asked again once the session starts.
 * Before that, the environment decides; the default is on.
 */
function readEnabled(pi: ExtensionAPI): boolean {
	const fromEnv = readEnvEnabled();
	if (fromEnv !== undefined) return fromEnv;
	try {
		return pi.getSettings().script?.enabled !== false;
	} catch {
		return true;
	}
}

/** Direct tools declared instead of `script` when the engine is off. */
const DIRECT_TOOLS = ["read", "bash", "edit", "write"];

function readInlineBudget(pi: ExtensionAPI): number | undefined {
	const budget = pi.getSettings().codemode?.inlineBudget;
	return typeof budget === "number" && Number.isFinite(budget) && budget >= 0 ? budget : undefined;
}

export function createCodemodeExtension(options: CodemodeExtensionOptions = {}): ExtensionFactory {
	return (pi) => {
		const enabled = readEnabled(pi);
		// A job that was running when the process ended can never finish. Say so once per session
		// start instead of leaving a row that looks alive forever.
		pi.on("session_start", async (event) => {
			if (event.reason === "startup" || event.reason === "new") return undefined;
			for (const entry of markInterrupted()) {
				pi.appendEntry(SCRIPT_JOB_ENTRY_TYPE, entry);
			}
			return undefined;
		});

		pi.on("session_start", async () => {
			if (readEnabled(pi)) return undefined;
			// Engine off: show the tools themselves. `script` is left registered but undeclared, so
			// `--tools script` still works and nothing changes for a session that asks for it.
			pi.setActiveTools([...new Set([...pi.getActiveTools().filter((name) => name !== "script" && name !== "wait_for_script"), ...DIRECT_TOOLS])]);
			return undefined;
		});

		pi.registerTool({
			...createCodemodeToolDefinition({
				appendEntry: (customType, data) => pi.appendEntry(customType, data),
				sendMessage: (message, options) => pi.sendMessage(message, options),
				models: options.models ?? true,
				getToolNamespace: (name) => pi.getAllTools().find((tool) => tool.name === name)?.namespace,
				getToolGuidelines: () =>
					new Map(pi.getAllTools().map((tool) => [tool.name, tool.promptGuidelines ?? []] as const)),
				getMode: () => options.mode ?? readMode(pi),
				getInlineBudget: () => options.inlineBudget ?? readInlineBudget(pi),
				getEnabled: () => enabled,
			}),
			defaultActive: enabled,
		});
		// `wait_for_script` is the declared partner of `script` and ships with it.
		pi.registerTool({
			...createWaitForScriptToolDefinition(),
			defaultActive: enabled,
		});
	};
}

export default createCodemodeExtension();
