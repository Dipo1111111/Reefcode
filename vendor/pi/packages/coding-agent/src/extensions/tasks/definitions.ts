/**
 * Subagent definitions: `.reef/agents/<name>.md` and `~/.reef/agents/<name>.md`.
 *
 * A definition is a prompt and a tool policy. It is not a session, not a fork, and it inherits
 * nothing: the child gets the definition body, a short `<delegation>` section, and the task
 * specification the parent writes. That is the whole point of delegation — the parent curates, the
 * child works, and the parent's cache stays warm.
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/** The tool categories a definition may ask for. */
export type ToolPolicyKind = "read-only" | "edit" | "execute" | "all";

/** Tools each category grants. A definition may also name tools explicitly. */
export const TOOL_SETS: Record<ToolPolicyKind, string[]> = {
	"read-only": ["read", "grep", "find", "ls"],
	edit: ["read", "grep", "find", "ls", "edit", "write"],
	execute: ["read", "grep", "find", "ls", "edit", "write", "bash"],
	all: ["read", "grep", "find", "ls", "edit", "write", "bash"],
};

/** Tools a child never gets, whatever the definition says. */
export const FORBIDDEN_CHILD_TOOLS = new Set(["task", "task_output", "task_stop", "wait_for_script"]);

export interface AgentDefinition {
	name: string;
	description: string;
	/** `inherit`, `different` (another family than the driver), a tier, or an explicit id. */
	model: string;
	reasoning?: string;
	/** A category, an explicit list, or both. */
	tools: { kind: ToolPolicyKind; explicit: string[] };
	/** The prompt. Everything after the frontmatter. */
	body: string;
	/** Where it came from, for `/agents`. */
	source: string;
}

export interface DefinitionProblem {
	source: string;
	message: string;
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;

/** Split `---` frontmatter from the body. No YAML library: the schema is flat on purpose. */
export function splitFrontmatter(text: string): { fields: Record<string, string>; body: string } | undefined {
	const normalized = text.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return undefined;
	const end = normalized.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const head = normalized.slice(3, end).trim();
	const body = normalized.slice(normalized.indexOf("\n", end + 1) + 1).trim();
	const fields: Record<string, string> = {};
	for (const line of head.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const colon = trimmed.indexOf(":");
		if (colon < 0) continue;
		fields[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
	}
	return { fields, body };
}

function parseList(value: string): string[] {
	const inner = value.trim();
	if (inner.startsWith("[") && inner.endsWith("]")) {
		return inner
			.slice(1, -1)
			.split(",")
			.map((item) => item.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	return inner
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Parse and validate one definition file. Problems are returned, never thrown. */
export function parseDefinition(text: string, source: string): { definition?: AgentDefinition; problems: DefinitionProblem[] } {
	const problems: DefinitionProblem[] = [];
	const split = splitFrontmatter(text);
	if (!split) return { problems: [{ source, message: "missing `---` frontmatter block" }] };
	const { fields, body } = split;

	const name = fields.name || basename(source).replace(/\.md$/, "");
	if (!NAME_PATTERN.test(name)) {
		problems.push({ source, message: `name \`${name}\` must match ${NAME_PATTERN}` });
	}
	const description = fields.description?.trim();
	if (!description) problems.push({ source, message: "missing `description`" });
	if (!body) problems.push({ source, message: "the body is empty: that is the prompt" });

	const known = new Set(["name", "description", "model", "reasoning", "tools", "mcp"]);
	for (const key of Object.keys(fields)) {
		if (!known.has(key)) problems.push({ source, message: `unknown field \`${key}\`` });
	}

	const rawTools = fields.tools?.trim() ?? "read-only";
	const categories: ToolPolicyKind[] = ["read-only", "edit", "execute", "all"];
	let kind: ToolPolicyKind = "read-only";
	let explicit: string[] = [];
	if (categories.includes(rawTools as ToolPolicyKind)) {
		kind = rawTools as ToolPolicyKind;
	} else {
		explicit = parseList(rawTools);
		kind = "read-only";
		if (explicit.length === 0) problems.push({ source, message: `\`tools\` must be a category or a list of tool names` });
	}

	const model = fields.model?.trim() || "inherit";
	const named = model === "inherit" || model === "different" || ["light", "medium", "heavy"].includes(model);
	if (!named && !model.includes("/") && !model.includes("-")) {
		problems.push({
			source,
			message: `\`model\` must be inherit, different, light|medium|heavy, or a model id, not \`${model}\``,
		});
	}

	if (problems.length > 0) return { problems };
	return {
		definition: {
			name,
			description: description ?? "",
			model,
			reasoning: fields.reasoning?.trim() || undefined,
			tools: { kind, explicit },
			body,
			source,
		},
		problems,
	};
}

/** The tool names a definition grants, minus anything a child may not have. */
export function toolsFor(definition: AgentDefinition): string[] {
	const granted = definition.tools.explicit.length > 0 ? definition.tools.explicit : TOOL_SETS[definition.tools.kind];
	return [...new Set(granted)].filter((name) => !FORBIDDEN_CHILD_TOOLS.has(name));
}

export interface LoadedDefinitions {
	definitions: AgentDefinition[];
	problems: DefinitionProblem[];
	/** Files that were read. */
	sources: string[];
}

function listMarkdown(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => join(dir, name));
	} catch {
		return [];
	}
}

/**
 * Load personal definitions first, then project ones. A project definition with the same name
 * replaces the personal one: the repository's rules win inside the repository.
 */
export function loadDefinitions(cwd: string, agentDir = join(homedir(), ".reef", "agent")): LoadedDefinitions {
	const byName = new Map<string, AgentDefinition>();
	const problems: DefinitionProblem[] = [];
	const sources: string[] = [];

	const read = (path: string) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	};

	for (const dir of [join(agentDir, "agents"), join(cwd, ".reef", "agents")]) {
		for (const path of listMarkdown(dir)) {
			const text = read(path);
			if (text === undefined) continue;
			sources.push(path);
			const result = parseDefinition(text, path);
			problems.push(...result.problems);
			if (result.definition) byName.set(result.definition.name, result.definition);
		}
	}

	return { definitions: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), problems, sources };
}

/** The built-in agents, used when a project defines none. */
export const BUILTIN_AGENTS: AgentDefinition[] = [
	{
		name: "explorer",
		description: "Finds where something lives and reports the shape of it, reading only",
		model: "inherit",
		tools: { kind: "read-only", explicit: [] },
		source: "builtin",
		body: `You are an explorer. You answer one question about a codebase by reading it.

Rules:
- Search before you read, and read before you conclude. Name files and lines.
- Report what exists, not what should exist. No recommendations unless asked.
- If the question is ambiguous, answer the most useful reading of it and say which you chose.
- Finish in one message: findings, ordered by relevance, each with a path.`,
	},
	{
		name: "reviewer",
		description: "Reviews a diff for correctness, security, and migration risk",
		// A reviewer that shares the driver's family shares its blind spot. Reef picks another family
		// when one is configured, and says so when there is not.
		model: "different",
		tools: { kind: "read-only", explicit: [] },
		source: "builtin",
		body: `You are a senior reviewer. You are given a diff and the intent behind it.

Report, in order, and only what you can defend:
1. Correctness risks, with file:line
2. Security issues (injection, authz, secrets, unsafe deserialisation)
3. Migration and data risks
4. Missing tests

Do not propose rewrites. Do not edit files. If the diff is fine, say so in one line.`,
	},
	{
		name: "scout",
		description: "Runs commands to find out what is true on this machine: versions, failures, timings",
		model: "inherit",
		tools: { kind: "execute", explicit: [] },
		source: "builtin",
		body: `You are a scout. You answer questions about the state of this machine or this build by running
commands, not by guessing.

Rules:
- One command at a time when the next depends on the last; batch them when it does not.
- Quote the actual output that supports your answer, trimmed to the relevant lines.
- Never claim a version, a count, or a timing you did not read from output.
- Keep the final message short: the answer, then the evidence.`,
	},
];
