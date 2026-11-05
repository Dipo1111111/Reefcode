/**
 * The `codemode` tool: the model writes JavaScript that calls other tools. Scripts use `tools`,
 * `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`, `console.*`, and `return <value>`,
 * may start with a `// @options:` line, and reach the model catalog, classifiers, and image models
 * through `models.*`. Results start with a "Script completed" or "Script failed" header.
 *
 * Scripts can call the agent loop's nested tools: active `direct` tools and every `codemode` or
 * `deferred` tool. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
 * validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
 * calls. Only the script's output reaches the model; nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` resolves to its `structuredContent`, also for error
 *   results that carry one.
 * - Any other tool resolves to its text content as one string.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 *
 * A script that fails returns a normal error result that keeps its partial output, followed by
 * "Script error:" and the error. `store(key, value)` and `load(key)` keep JSON values across
 * calls; successful scripts append their writes to the session as `codemode-store` custom entries,
 * so each branch sees the values written on its own path.
 */

import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import { renderToolOutputType, renderToolSample, toCodemodeIdentifier } from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import { getDocsPath } from "../../config.ts";
import type { ToolDefinition, ToolLoadout, ToolLoadoutChanges, ToolNamespace } from "../../core/extensions/types.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { SETTINGS_DEFAULTS } from "../../core/settings-defaults.ts";
import type { CodemodeMode } from "../../core/settings-manager.ts";
import { type TypeBoxAgentTool, wrapToolDefinition } from "../../core/tools/tool-definition-wrapper.ts";
import { createJob, finishJob, formatBytes, formatDuration, newJobId, SCRIPT_JOB_ENTRY_TYPE, toEntryData } from "./jobs.ts";
import { loadCodemodeExecutor } from "./execute.lazy.ts";
import { codemodeRenderers } from "./renderer.ts";

export const CODEMODE_TOOL_NAME = "script";
/** `wait_for_script` is the declared pair of `script`. */
export const WAIT_TOOL_NAME = "wait_for_script";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

/** The part of the model registry that scripts reach through `models`. */
export type CodemodeModelRuntime = Pick<
	ModelRegistry,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify" | "generateImages"
>;

export interface CodemodeToolOptions {
	/** Namespace of a tool, for `searchTools()` ranking and its `namespace` filter. */
	getToolNamespace?: (toolName: string) => ToolNamespace | undefined;
	/** Prompt guidelines of every tool, by tool name, shown with declarations by `describeTool()` and `ALL_TOOLS`. */
	getToolGuidelines?: () => ReadonlyMap<string, readonly string[]>;
	/**
	 * Expose the `models` namespace to scripts, backed by the session's model registry
	 * (`ctx.modelRegistry`). Without it, `models` is not declared.
	 */
	models?: boolean;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData | unknown) => void;
	/** Sends a custom message to the session; used to wake the model when a background script ends. */
	sendMessage?: (message: any, options?: { deliverAs?: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean }) => void;
	/** How the tool presents the loadout while active (the `codemode.mode` setting). Default: `on`. */
	getMode?: () => CodemodeMode;
	/** `script.enabled`; false means declare tools directly instead (ADR-014). */
	getEnabled?: () => boolean;
	/** One-line tool listing instead of signature blocks. Default: true. */
	getCompact?: () => boolean;
	/** Token budget for tool declarations in the description. Default: {@link DEFAULT_CODEMODE_INLINE_BUDGET}. */
	getInlineBudget?: () => number | undefined;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	script: Type.String({
		description:
			"JavaScript source, run as an async function body. Not JSON, no code fence. Input text goes in `// @input: name <<'EOF'` blocks and is read as `inputs.name`.",
	}),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<codemode call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
	/** Cost in USD of a `models.*` call that reported usage. */
	cost?: number;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	/** Temp file with the full text output, when the output was truncated. */
	fullOutputPath?: string;
}

/**
 * The one-line status a script result starts with, so the model and the user see the same thing:
 *
 *   [Script completed · 4 calls · 12.3 KiB passed through unfiltered · 8.1s]
 *   [Script failed · before any call · 0.2s]
 *   [Script failed · after call 3 (read) · 3 calls · 4.0 KiB passed through unfiltered · 8.1s]
 *
 * A single call script says `1 call` and omits the passthrough figure: nothing was passed through.
 */
export function scriptStatusLine(
	ok: boolean,
	calls: readonly CodemodeNestedCall[],
	passthroughBytes: number,
	seconds: number,
): string {
	const parts: string[] = [ok ? "Script completed" : "Script failed"];
	const last = calls[calls.length - 1];
	if (!ok) {
		parts.push(last ? `after call ${calls.length} (${last.name})` : "before any call");
	}
	if (calls.length > 0) parts.push(`${calls.length} ${calls.length === 1 ? "call" : "calls"}`);
	if (passthroughBytes > 0 && calls.length > 1) {
		parts.push(`${formatBytes(passthroughBytes)} passed through unfiltered`);
	}
	parts.push(`${seconds.toFixed(1)}s`);
	return `[${parts.join(" · ")}]`;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run one script that calls several tools",
	guidelines: [
		"Reach for `script` when a step needs three or more tool calls, a loop over discovered results, or a filter that would otherwise put megabytes through the transcript. One call at a time stays a direct call.",
		"Put long inputs in `// @input: name <<'EOF'` blocks and read `inputs.name`, never inline them in the code.",
	],
} as const;

/** The reference for scripts: globals, tool results, `store()`, the `models` API, and limits. */
export const CODEMODE_DOCS_PATH = join(getDocsPath(), "codemode.md");

const DESCRIPTION_INTRO = `Run one script that calls several tools. The input is JavaScript (not JSON, no code fence), run as an async function body: top-level \`await\` and \`return\` work. No imports, no file system, no network, no \`fetch\`.
- \`await tools.<tool>({ ...args })\` calls a tool. It resolves to the tool's output (a string, or an object when the declaration says so) and rejects with an Error when the call fails or is denied.
- A script earns its turn by doing several calls. Batch independent ones with \`Promise.allSettled\`; loop when the data decides the next call. **A script with one call costs more than calling the tool once** — measured at +40% tokens on small tasks — so do it directly instead.
- First line, optional: \`// @options: {"max_output_tokens": 10000, "timeout_ms": 60000}\` (\`// @script:\` is an alias). \`startInBackground\` continues the script after the tool returns.
- Long input text (a file body, a patch, a heredoc) goes in an input block instead of inside the code: \`// @input: patch <<'EOF'\` then the text, then a line with only \`EOF\`. Read it as \`inputs.patch\`. Blocks must be closed and are removed before the script runs.
- Every tool you have is listed below with its arguments. Do not open with a discovery call; the first call should be real work.
- Create files with \`tools.write\`, change them with \`tools.edit\` — not shell redirection or \`sed -i\`.`;

/** One line per global. The details live in {@link CODEMODE_DOCS_PATH}. */
function describeGlobals(models: boolean): string {
	const lines = [
		"Globals:",
		"- `text(value)`, `image(dataUrlOrImageBlock)`, `console.log(...)`, and top-level `return` add output; `exit()` ends the script. With several text items, each starts with a `==> text N/M <==` line, and `console` lines follow the other output in one `<console_output>` block. `image()` also saves the image to a temp file and the result names its path.",
		"- `inputs.<name>` holds each `// @input:` block as a string; the object is frozen and never contains anything else.",
		"- `store(key, value)` and `load(key)` keep JSON values across script calls.",
		"- `ALL_TOOLS`, `searchTools(query)`, `describeTool(name)`, `describeNamespace(name)`: only for tools that are **not** listed below, such as MCP servers that connect later.",
	];
	if (models) {
		lines.push(`- \`models\`: classifiers and image generation. Read ${CODEMODE_DOCS_PATH} first.`);
	}
	return lines.join("\n");
}

/** Default for {@link CodemodeDescriptionOptions.inlineBudget}, in estimated tokens. */
export const DEFAULT_CODEMODE_INLINE_BUDGET = SETTINGS_DEFAULTS.codemode.inlineBudget;
/** Characters per token when estimating the cost of a tool section. */
const CHARS_PER_TOKEN = 4;

/**
 * What a script sees of a tool: its description followed by its prompt guidelines, which the system
 * prompt only has for declared tools. Tools without an output schema resolve to their text output.
 */
export function toCodemodeDeclaration(
	tool: AgentTool<any>,
	guidelines: readonly string[] = [],
): Omit<CodemodeTool, "execute"> {
	const bullets = guidelines.flatMap((guideline) => (guideline.trim() ? [`- ${guideline.trim()}`] : []));
	return {
		name: tool.name,
		description: bullets.length > 0 ? `${tool.description.trim()}\n\n${bullets.join("\n")}` : tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the codemode tool itself. */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/**
	 * List each tool as one line — `name(args) → output` — instead of a signature block with prose.
	 * Measured: the full listing was ~1,030 tokens, about what the four declarations it replaced
	 * cost, so the whole prompt saving of the script engine disappeared. Prose is still available
	 * through `await describeTool(name)`, which costs a call only when it is needed.
	 */
	compact?: boolean;
	/** Declare the `models` namespace; only for tools created with model access. */
	models?: boolean;
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Tools that are callable but never listed with their declaration (`deferred` exposure). */
	deferred?: ReadonlySet<string>;
	/** Prompt guidelines of each tool, by tool name, listed after its description. */
	guidelines?: ReadonlyMap<string, readonly string[]>;
	/**
	 * Estimated tokens (characters / 4) the tool sections may use. Tools that do not fit are left
	 * out, like deferred tools. Unset lists every tool that is not deferred.
	 */
	inlineBudget?: number;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

/** One line: `- read({ path, offset?, limit? }) → string`. */
function renderCompactSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const args = describeFields(declaration.inputSchema, 0) ?? "{ args }";
	const output = describeOutput(declaration.name, declaration.outputSchema);
	return `- \`tools.${id}(${args})\` → ${output}`;
}

interface CatalogEntry {
	name: string;
	section: string;
	cost: number;
}

interface CatalogGroup {
	namespace: ToolNamespace | undefined;
	entries: CatalogEntry[];
}

/**
 * Pick the tool sections that fit the budget, like OpenCode's catalog: in each round every group
 * (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a
 * group whose next tool does not fit drops out while the others continue. Every namespace is
 * represented before any namespace is complete.
 */
function selectCatalog(groups: readonly CatalogGroup[], budget: number | undefined): Set<string> {
	if (budget === undefined) return new Set(groups.flatMap((group) => group.entries.map((entry) => entry.name)));
	const queues = groups.map((group) => [...group.entries].sort((a, b) => a.cost - b.cost));
	const shown = new Set<string>();
	let remaining = budget;
	let active = queues.filter((queue) => queue.length > 0);
	while (active.length > 0) {
		active = active.filter((queue) => {
			const next = queue[0];
			if (next.cost > remaining) return false;
			remaining -= next.cost;
			shown.add(next.name);
			queue.shift();
			return queue.length > 0;
		});
	}
	return shown;
}

/**
 * Model-facing description: the helper list, guidance for finding tools that are not listed, the
 * `models` API, and one section per listed tool, grouped by namespace. Deferred tools are never
 * listed and do not affect the description at all, so it stays the same while tools are registered
 * late (for example by MCP servers that connect). Tool sections are limited to `inlineBudget`.
 */
export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const declarations = getCodemodeCallableTools(tools)
		.filter((tool) => !options.deferred?.has(tool.name))
		.map((tool) => toCodemodeDeclaration(tool, options.guidelines?.get(tool.name)));
	const groups = new Map<string, CatalogGroup>([["", { namespace: undefined, entries: [] }]]);
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		const key = namespace ? `ns:${namespace.name}` : "";
		const group = groups.get(key) ?? { namespace, entries: [] };
		groups.set(key, group);
		const section = options.compact ? renderCompactSection(declaration) : renderToolSection(declaration);
		group.entries.push({ name: declaration.name, section, cost: Math.ceil(section.length / CHARS_PER_TOKEN) });
	}
	const ordered = [...groups.values()].sort((a, b) =>
		a.namespace === undefined ? -1 : b.namespace === undefined ? 1 : a.namespace.name.localeCompare(b.namespace.name),
	);
	const shown = selectCatalog(ordered, options.inlineBudget);

	const sections = [DESCRIPTION_INTRO, describeGlobals(options.models === true)];
	if (declarations.length === 0) return sections.join("\n\n");

	if (options.compact) {
		// One line per tool: what it is called with, and what it resolves to. No prose, no sample.
		const lines = ["Nested tools (`await tools.<name>(args)`; `describeTool(name)` for full prose):"];
		for (const { namespace, entries } of ordered) {
			if (namespace) lines.push(`## ${namespace.name}`);
			for (const entry of entries) lines.push(entry.section);
		}
		sections.push(lines.join("\n"));
		return sections.join("\n\n");
	}

	const toolSections = ["Nested tools:"];
	for (const { namespace, entries } of ordered) {
		const visible = entries.filter((entry) => shown.has(entry.name));
		if (namespace) {
			// Only tools that did not fit the budget are counted as not listed here.
			const listing =
				visible.length === entries.length
					? ""
					: visible.length === 0
						? " (tools not listed)"
						: " (some tools not listed)";
			const description = namespace.description?.trim();
			toolSections.push(`## ${namespace.name}${listing}${description ? `\n${description}` : ""}`);
		}
		for (const entry of visible) toolSections.push(entry.section);
	}
	sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

/**
 * The field names of an object schema, `{ output, exit_code, full_output_path? }`, with the fields of
 * object-typed fields `depth` levels deep: `{ content, structuredContent?: { results } }`, and the
 * value of `const` fields: `{ action: "start", id }`. Undefined for other schemas.
 */
function describeFields(schema: unknown, depth: number): string | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const { type, properties, required } = schema as Record<string, unknown>;
	if (type !== "object" || typeof properties !== "object" || properties === null) return undefined;
	const requiredNames = new Set(Array.isArray(required) ? required : []);
	const fields = Object.entries(properties).map(([name, field]) => {
		const constValue = (field as Record<string, unknown> | null)?.const;
		const nested =
			constValue !== undefined
				? JSON.stringify(constValue)
				: depth > 0
					? describeFields(field, depth - 1)
					: undefined;
		return `${name}${requiredNames.has(name) ? "" : "?"}${nested ? `: ${nested}` : ""}`;
	});
	return `{ ${fields.join(", ")} }`;
}

/**
 * What a script call resolves to, in one line: `a string`, the field names of an object (see
 * {@link describeFields}), the field names of each object in a union, the rendered type when it
 * fits on one line, or a pointer to `describeTool()` for anything longer. The full type of a large
 * schema would otherwise be sent with every request (#11501).
 */
function describeOutput(name: string, schema: CodemodeJsonSchema | undefined): string {
	const type = renderToolOutputType(schema);
	if (type === "string") return "a string";
	const fields = describeFields(schema, 1) ?? describeUnionFields(schema);
	if (fields) return `\`${fields}\``;
	if (!type.includes("\n")) return `\`${type}\``;
	return `a value; \`await describeTool(${JSON.stringify(name)})\` shows its type`;
}

/**
 * The field names of each variant of an `anyOf`/`oneOf` whose variants are all objects, joined by
 * `|`.
 */
function describeUnionFields(schema: unknown): string | undefined {
	if (typeof schema !== "object" || schema === null) return undefined;
	const { anyOf, oneOf } = schema as Record<string, unknown>;
	const variants = anyOf ?? oneOf;
	if (!Array.isArray(variants) || variants.length === 0) return undefined;
	const described = variants.map((variant) => describeFields(variant, 0));
	return described.every((fields) => fields !== undefined) ? described.join(" | ") : undefined;
}

/**
 * A declared tool's description followed by how scripts call it and what the call resolves to. The
 * arguments are the tool's declared parameters, so they are not repeated.
 */
function describeScriptCall(tool: AgentTool<any>): string {
	return `${tool.description.trim()}\n\nCodemode: \`tools.${toCodemodeIdentifier(tool.name)}(args)\` resolves to ${describeOutput(tool.name, toCodemodeDeclaration(tool).outputSchema)}.`;
}

/**
 * How the codemode tool presents tools that are both declared and callable from scripts:
 * - `on`: their descriptions say how scripts call them, and the codemode description
 *   lists only the callable tools without `direct` exposure.
 * - `only`: the codemode description lists every callable tool, and requests leave out the
 *   declarations of active `direct` tools.
 *
 * Listed tools carry their prompt guidelines, which the system prompt only has for declared tools.
 *
 * Listing by exposure, not by the active set, keeps the codemode description unchanged when
 * `tool_search` loads a tool, so loads do not redeclare codemode.
 */
function prepareCodemodeLoadout(loadout: ToolLoadout, options: CodemodeToolOptions): ToolLoadoutChanges | undefined {
	// Script engine off: nothing is hidden and nothing is annotated, so every active tool keeps its
	// own declaration. This is the direct-tool baseline. (ADR-014, `script.enabled`)
	if (options.getEnabled?.() === false) return undefined;
	const mode = options.getMode?.() ?? SETTINGS_DEFAULTS.codemode.mode;
	const isDirect = (tool: AgentTool) => loadout.getExposure(tool.name) === "direct";
	const callable = getCodemodeCallableTools(loadout.callable);
	const callableNames = new Set(callable.map((tool) => tool.name));
	const descriptions: Record<string, string> = {};
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (callableNames.has(tool.name)) descriptions[tool.name] = describeScriptCall(tool);
		}
	}
	// Direct tools stay out of the listing while they have their own declaration: repeating them
	// would spend the budget twice. A direct tool whose declaration is hidden has no other way to be
	// found, so it is listed here.
	const hiddenNow = new Set<string>(
		mode === "only" ? [] : loadout.declared.filter((tool) => isDirect(tool)).map((tool) => tool.name),
	);
	const listed =
		mode === "only" ? callable : callable.filter((tool) => !isDirect(tool) || hiddenNow.has(tool.name));
	const namespaces = new Map(
		listed.flatMap((tool) => {
			const namespace = loadout.getNamespace(tool.name);
			return namespace ? [[tool.name, namespace] as const] : [];
		}),
	);
	const guidelines = new Map(listed.map((tool) => [tool.name, loadout.getPromptGuidelines(tool.name)] as const));
	descriptions[CODEMODE_TOOL_NAME] = createCodemodeDescription(listed, {
		compact: options.getCompact?.() ?? true,
		models: options.models === true,
		namespaces,
		guidelines,
		deferred: new Set(
			listed.filter((tool) => loadout.getExposure(tool.name) === "deferred").map((tool) => tool.name),
		),
		inlineBudget: options.getInlineBudget?.() ?? DEFAULT_CODEMODE_INLINE_BUDGET,
	});
	const declaredNames = new Set(loadout.declared.map((tool) => tool.name));
	// REEF: the declared surface is `script` and `wait_for_script`. Every other direct tool stays
	// active and callable from a script, but its declaration is left out, which is where most of the
	// prompt budget comes from. `codemode.mode = "on"` keeps the old behaviour.
	const hidden = new Set<string>(
		mode === "only"
			? callable.filter((tool) => isDirect(tool) && declaredNames.has(tool.name)).map((tool) => tool.name)
			: [],
	);
	if (mode === "on") {
		for (const tool of loadout.declared) {
			if (tool.name === CODEMODE_TOOL_NAME || tool.name === WAIT_TOOL_NAME) continue;
			if (isDirect(tool)) hidden.add(tool.name);
		}
	}
	return { descriptions, hiddenDeclarations: [...hidden] };
}

/** Script globals that list or look up tools and namespaces, which the script may then call by any name. */
const DISCOVERY_GLOBALS = /\b(searchTools|describeNamespace|describeTool|ALL_TOOLS)\b/;

/**
 * The tools a script may call (`ToolDefinition.reachesTools`): every tool when it uses a discovery
 * global, else the words of its source, so `tools.mcp__docs__search` and
 * `tools["mcp__docs__" + name]` both name the `mcp__docs` namespace.
 */
function getScriptReach(code: unknown): "all" | readonly string[] {
	if (typeof code !== "string") return [];
	return DISCOVERY_GLOBALS.test(code) ? "all" : (code.match(/\w+/g) ?? []);
}

/** Whether the source's first line asks for a background run. */
function wantsBackground(source: string): boolean {
	const first = source.trimStart().slice(0, 200);
	return /^\/\/\s*@(script|options):\s*\{[^}]*"startInBackground"\s*:\s*true/.test(first);
}

/** Tell the model a background script ended, when nobody was waiting on it. */
function notifyFinish(
	options: CodemodeToolOptions,
	job: { id: string; status: string; startedAt: number },
	result: { content?: readonly unknown[]; isError?: boolean },
): void {
	const text = (result.content ?? [])
		.map((item) => (typeof item === "object" && item !== null && "text" in item ? String((item as { text: unknown }).text) : ""))
		.join("\n")
		.trim();
	options.sendMessage?.(
		{
			customType: SCRIPT_JOB_ENTRY_TYPE,
			content: [{ type: "text", text: `Background script ${job.id} finished (${job.status}, ${formatDuration(Date.now() - job.startedAt)}).\n\n${text}` }],
			display: false,
			details: { jobId: job.id, status: job.status },
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		description: createCodemodeDescription([], { models: options.models === true }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		exposure: "model-only",
		defaultActive: true,
		prepareLoadout: (loadout) => prepareCodemodeLoadout(loadout, options),
		reachesTools: (input) => getScriptReach(String(input.script ?? "")),
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const execute = await loadCodemodeExecutor();
			if (!wantsBackground(params.script)) {
				return execute.executeCodemode(toolCallId, params, signal, onUpdate, ctx, options);
			}
			// Background: return the job id now, keep the run going, and wake the model when it ends.
			const id = newJobId();
			const abort = new AbortController();
			const job = createJob(id, toolCallId, abort);
			if (signal) {
				if (signal.aborted) abort.abort(signal.reason);
				else signal.addEventListener("abort", () => abort.abort(signal.reason), { once: true });
			}
			options.appendEntry?.(SCRIPT_JOB_ENTRY_TYPE, toEntryData(job));
			let lastCalls = 0;
			const track = (result: { details?: { calls?: readonly unknown[] } } | undefined) => {
				const calls = result?.details?.calls?.length ?? 0;
				if (calls !== lastCalls) {
					lastCalls = calls;
					job.calls = calls;
				}
			};
			job.promise = execute
				.executeCodemode(toolCallId, params, abort.signal, (result) => track(result), ctx, options)
				.then((result) => {
					const failed = result.isError === true;
					finishJob(job, abort.signal.aborted ? "killed" : failed ? "failed" : "done");
					lastCalls = result.details?.calls?.length ?? lastCalls;
					job.calls = lastCalls;
					options.appendEntry?.(SCRIPT_JOB_ENTRY_TYPE, toEntryData(job));
					if (!job.awaiting) notifyFinish(options, job, result);
					return result;
				})
				.catch((error: unknown) => {
					finishJob(job, abort.signal.aborted ? "killed" : "failed");
					options.appendEntry?.(SCRIPT_JOB_ENTRY_TYPE, toEntryData(job));
					const text = error instanceof Error ? error.message : String(error);
					const result = { content: [{ type: "text" as const, text: `[Script failed · after call ${job.calls} · ${formatDuration(Date.now() - job.startedAt)}]\n\nScript error:\n${text}` }], details: { calls: [] }, isError: true };
					if (!job.awaiting) notifyFinish(options, job, result);
					return result;
				});
			return {
				content: [
					{
						type: "text" as const,
						text: `[Script started · ${id} · running in the background]\n\nCall wait_for_script({ toolCallId: "${id}" }) to wait for it, or { action: "status" } to poll it.`,
					},
				],
				details: { calls: [] },
			};
		},
		...codemodeRenderers,
	};
}

/**
 * Create the codemode tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): TypeBoxAgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models === true }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
