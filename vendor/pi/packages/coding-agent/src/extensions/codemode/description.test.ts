import { describe, expect, it } from "vitest";
import { createCodemodeDescription } from "./tool.ts";

/** A tool as the description builder sees it: name, prose, params, output shape. */
function tool(name: string, description: string, params: Record<string, unknown>, output: unknown = { type: "string" }) {
	return {
		name,
		description,
		parameters: { type: "object", properties: params, required: Object.keys(params).slice(0, 1) },
		outputSchema: output,
	} as never;
}

const tools = [
	tool("read", "Read a file from the workspace and return its text with line numbers.", {
		path: { type: "string" },
		offset: { type: "number" },
		limit: { type: "number" },
	}),
	tool("bash", "Run a shell command and return its output, with a durable artifact when truncated.", {
		command: { type: "string" },
		timeout: { type: "number" },
	}),
	tool("edit", "Replace an exact block of text in a file.", { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }),
	tool("write", "Write a whole file, creating parent directories.", { path: { type: "string" }, content: { type: "string" } }),
	tool("grep", "Search file contents by pattern and return matching lines.", { pattern: { type: "string" }, path: { type: "string" } }),
	tool("find", "Find files by glob and return their paths.", { glob: { type: "string" } }),
	tool("ls", "List the entries of a directory.", { path: { type: "string" } }),
	tool("task", "Delegate a self-contained job to a subagent and return its report.", {
		prompt: { type: "string" },
		subagent_type: { type: "string" },
		context: { type: "string" },
	}),
];

const estimate = (text: string) => Math.ceil(text.length / 4);

describe("codemode description", () => {
	it("compact lists every tool on one line with its arguments and return", () => {
		const text = createCodemodeDescription(tools, { compact: true });
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "task"]) expect(text).toContain(name);
		expect(text).toContain("tools.read({ path, offset?, limit? })");
		expect(text).toContain("→ a string");
	});

	it("compact drops the prose but keeps the shape", () => {
		const compact = estimate(createCodemodeDescription(tools, { compact: true }));
		const full = estimate(createCodemodeDescription(tools, {}));
		const text = createCodemodeDescription(tools, { compact: true });
		// The invariant: no tool prose in the listing, because that is the expensive part and it is
		// still reachable through `describeTool(name)`.
		expect(text).not.toContain("Read a file from the workspace");
		expect(compact).toBeLessThan(full);
		// Real tools carry longer descriptions than these fixtures; the live measurement after this
		// change is what confirms the size, not this assertion.
		expect(compact).toBeLessThan(760);
	});

	it("compact keeps the batching rule, because that is what makes a script worth a turn", () => {
		const text = createCodemodeDescription(tools, { compact: true });
		expect(text).toContain("A script earns its turn by doing several calls");
		expect(text).toContain("costs more than calling the tool once");
	});

	it("says where the prose went", () => {
		expect(createCodemodeDescription(tools, { compact: true })).toContain("describeTool(name)");
	});
});
