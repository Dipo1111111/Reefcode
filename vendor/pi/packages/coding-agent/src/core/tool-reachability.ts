import type { ToolExposure } from "./extensions/types.ts";

/**
 * Whether a registered tool can be called from a script (`tools.<name>`), used by
 * `AgentSession._getCallableTools()`.
 *
 * The first version said "every registered direct tool while a script is active", which is wrong in
 * two ways that both showed up in real use:
 *
 * - `powershell` is registered on every platform but is not a default tool off Windows. It became
 *   callable on macOS, where it cannot run; the model asked for `tools.shell`, was told
 *   `tools.powershell` was close, and spent a turn on it.
 * - Tools with `defaultActive: false` (the `task` tools) and tools of disabled extensions became
 *   callable, which bypasses the activation rules: the model could reach a tool the user had not
 *   enabled.
 *
 * The pool is therefore the set the session would actually give the model: active, deliberately
 * hidden while still active (so hiding a declaration does not remove it from scripts), or a default
 * tool. `codemode` and `deferred` exposure stay reachable, because being reachable-only is the point
 * of those exposures.
 */
export interface ToolReachability {
	name: string;
	exposure: ToolExposure | undefined;
	/** The tools the session has active for this loadout. */
	active: ReadonlySet<string>;
	/** Tools whose declaration was hidden while they stayed active. */
	hiddenWhileActive: ReadonlySet<string>;
	/** Whether `--tools`/`--exclude-tools` keep the tool registered. */
	allowed: boolean;
	/** `defaultActive` from the tool definition; `false` means "only when named". */
	defaultActive: boolean | undefined;
	/** The session's default tool names (`defaultTools` setting, else the built-in list). */
	defaults: readonly string[];
}

export function isToolReachable(tool: ToolReachability): boolean {
	if (tool.exposure === "hidden") return false;
	if (tool.hiddenWhileActive.has(tool.name)) return true;
	if (tool.exposure === "codemode" || tool.exposure === "deferred") return true;
	if (tool.exposure !== "direct") return false;
	if (tool.active.has(tool.name)) return true;
	if (!tool.allowed) return false;
	if (tool.defaultActive === false) return false;
	return tool.defaults.includes(tool.name);
}
