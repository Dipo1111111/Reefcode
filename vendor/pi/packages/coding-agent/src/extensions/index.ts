import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import safetyExtension from "./safety/index.ts";
import reefStatsExtension from "./reef-stats/index.ts";
import tasksExtension from "./tasks/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// The safety floor. Not replaceable: a third-party extension must not be able to remove it.
	{ name: "safety", factory: safetyExtension, builtin: true },
	{ name: "reef-stats", factory: reefStatsExtension, builtin: true },
	{ name: "tasks", factory: tasksExtension, builtin: true },
];
