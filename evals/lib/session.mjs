/**
 * Read a REEF session file and total what it cost.
 *
 * Parent turns and delegated turns are counted separately, because the interesting question is
 * whether delegation shrinks the *parent's* transcript. A subagent that does the work but leaves the
 * parent paying the same is not a saving.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function newestSession(sessionDir) {
	let files;
	try {
		files = readdirSync(sessionDir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => join(sessionDir, name));
	} catch {
		return undefined;
	}
	if (files.length === 0) return undefined;
	return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** Entries are appended one JSON object per line; a partial final line is ignored. */
export function readEntries(path) {
	const entries = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// A half-written line from an interrupted run.
		}
	}
	return entries;
}

export function summarize(entries) {
	const parent = { requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, promptTokens: 0 };
	const delegated = { tasks: 0, turns: 0, input: 0, output: 0, cost: 0 };
	let messages = 0;

	for (const entry of entries) {
		if (entry.type === "message") {
			messages += 1;
			continue;
		}
		if (entry.type !== "custom") continue;
		const data = entry.data ?? {};
		if (entry.customType === "reef-request") {
			parent.requests += 1;
			parent.input += data.input ?? 0;
			parent.output += data.output ?? 0;
			parent.cacheRead += data.cacheRead ?? 0;
			parent.cost += data.cost ?? 0;
			parent.promptTokens = data.promptTokens ?? parent.promptTokens;
		}
		if (entry.customType === "reef-task") {
			delegated.tasks += 1;
			delegated.turns += data.turns ?? 0;
			delegated.input += data.usage?.input ?? 0;
			delegated.output += data.usage?.output ?? 0;
			delegated.cost += data.usage?.cost ?? 0;
		}
	}

	const parentTokens = parent.input + parent.cacheRead + parent.output;
	const delegatedTokens = delegated.input + delegated.output;

	return {
		...parent,
		messages,
		delegated,
		parentTokens,
		delegatedTokens,
		// The number the kill criterion is about: tokens billed per completed task.
		totalTokens: parentTokens + delegatedTokens,
		totalCost: parent.cost + delegated.cost,
	};
}

/**
 * The text the user actually saw. Grading must read this, not raw stdout: stdout carries tool
 * output too, so a secret the model correctly refused to repeat still appears there after it
 * reads the file that contains it.
 */
export function finalAssistantText(entries) {
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (typeof content === "string") return content.trim();
		if (Array.isArray(content)) {
			const text = content
				.filter((part) => part?.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
	}
	return "";
}
