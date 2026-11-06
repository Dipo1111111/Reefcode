/**
 * The request compiler's instruments: section budgets, volatility ordering, and the cache contract.
 *
 * `docs/05-context-economy.md` makes one claim we can enforce rather than hope for: the request is
 * append-only. This module owns that claim. Every request is snapshotted, each stage hashed, and the
 * diff against the previous snapshot is either an append or a declared break. Anything else is a
 * violation, and a violation is reported with enough evidence to fix it.
 */

import { createHash } from "node:crypto";

export interface SectionBudget {
	/** What the section should cost on a fresh session. */
	target: number;
	/** Past this, the section is truncated by its own policy. */
	cap: number;
}

/**
 * `docs/05` §2.1. The ordering matters as much as the numbers: the prompt is laid out most stable
 * first, most volatile last, so the cached prefix is as long as it can be.
 */
export const SECTION_BUDGETS: Record<string, SectionBudget> = {
	preamble: { target: 550, cap: 900 },
	tools: { target: 900, cap: 1200 },
	rules: { target: 400, cap: 700 },
	docs: { target: 300, cap: 500 },
	addendum: { target: 200, cap: 600 },
	environment: { target: 150, cap: 250 },
	cwd: { target: 20, cap: 60 },
	project_context: { target: 1800, cap: 3500 },
	skills: { target: 500, cap: 900 },
	spec: { target: 0, cap: 700 },
	jobs: { target: 0, cap: 600 },
};

/** Stable-to-volatile order. A section not listed here is appended after the known ones. */
export const SECTION_ORDER: readonly string[] = [
	"preamble",
	"tools",
	"rules",
	"docs",
	"addendum",
	"environment",
	"cwd",
	"project_context",
	"skills",
	"spec",
	"jobs",
];

export function estimateTokens(text: string): number {
	return Math.round(text.length / 3.6);
}

function hash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Order sections so the cacheable prefix is long. Unknown sections keep insertion order at the end. */
export function orderSections(sections: Record<string, string>): Record<string, string> {
	const ordered: Record<string, string> = {};
	for (const name of SECTION_ORDER) {
		if (sections[name] !== undefined) ordered[name] = sections[name];
	}
	for (const [name, text] of Object.entries(sections)) {
		if (ordered[name] === undefined) ordered[name] = text;
	}
	return ordered;
}

export interface BudgetResult {
	sections: Record<string, string>;
	/** Sections that had to be truncated, with what was dropped. */
	truncated: { name: string; kept: number; dropped: number; tokens: number }[];
	tokens: number;
}

/** Keep the head and the tail of a long section, and say so where the model can see it. */
function truncateMiddle(name: string, text: string, capTokens: number): string {
	const capChars = Math.floor(capTokens * 3.6);
	const head = Math.floor(capChars * 0.6);
	const tail = Math.floor(capChars * 0.2);
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[... ${omitted} bytes of \`${name}\` omitted to fit its budget. Read the source file if you need the rest. ...]\n\n${text.slice(text.length - tail)}`;
}

/** Keep every line's label, drop the trailing prose from the lines that cost the most. */
function truncateSkills(text: string, capTokens: number): string {
	const capChars = Math.floor(capTokens * 3.6);
	if (text.length <= capChars) return text;
	const lines = text.split("\n");
	const kept: string[] = [];
	let used = 0;
	for (const line of lines) {
		const label = line.length > 80 ? `${line.slice(0, 77)}...` : line;
		if (kept.length > 0 && used + label.length + 1 > capChars) {
			kept.push(`[... ${lines.length - kept.length} more skills listed by name only. Run \`searchTools\` for the rest.]`);
			break;
		}
		kept.push(label);
		used += label.length + 1;
	}
	return kept.join("\n");
}

/**
 * Apply the section budgets. Over-budget sections are truncated by their own policy: project
 * context keeps head and tail, skills keep their names, everything else keeps its head. Nothing is
 * dropped silently — the omission is written into the section it came from.
 */
export function applySectionBudgets(sections: Record<string, string>): BudgetResult {
	const ordered = orderSections(sections);
	const result: Record<string, string> = {};
	const truncated: BudgetResult["truncated"] = [];
	let total = 0;

	for (const [name, text] of Object.entries(ordered)) {
		const budget = SECTION_BUDGETS[name];
		const tokens = estimateTokens(text);
		if (!budget || tokens <= budget.cap || name === "cwd") {
			result[name] = text;
			total += tokens;
			continue;
		}
		const next =
			name === "project_context" ? truncateMiddle(name, text, budget.cap) : name === "skills" ? truncateSkills(text, budget.cap) : truncateMiddle(name, text, budget.cap);
		const keptTokens = estimateTokens(next);
		result[name] = next;
		total += keptTokens;
		truncated.push({ name, kept: next.length, dropped: text.length - next.length, tokens: keptTokens });
	}
	return { sections: result, truncated, tokens: total };
}

/** Events that are allowed to invalidate the cache. Everything else is a violation. */
export type CacheBreak =
	| "none"
	| "first_request"
	| "compaction"
	| "model_change"
	| "session_switch"
	| "rollback"
	| "fork"
	| "spec_mode_enter"
	| "tool_schema_change";

export const CACHE_BREAKS: readonly CacheBreak[] = [
	"none",
	"first_request",
	"compaction",
	"model_change",
	"session_switch",
	"rollback",
	"fork",
	"spec_mode_enter",
	"tool_schema_change",
];

export interface RequestSnapshot {
	/** Hash per section, so a violation names the section that moved. */
	sections: Record<string, string>;
	tools: string[];
	/** Hash of each message, in order. */
	messages: string[];
	/** Estimated tokens of each message, so the reused prefix can be priced. */
	messageTokens: number[];
	/** Tokens that ride with the tool block, so they can be counted when the block is unchanged. */
	extraTokens: Record<string, number>;
	/** Hash of the exact tools + sections text. */
	prefix: string;
	tokens: number;
	at: number;
}

export interface RequestAudit {
	request: number;
	/** True when this request extends the previous one and the cache can be reused. */
	appendOnly: boolean;
	breakReason: CacheBreak;
	/** Human-readable, evidence-bearing. Empty when appendOnly or the break is declared. */
	violations: string[];
	/** Tokens of the part of the request that repeats the previous one. */
	cacheablePrefixTokens: number;
	tokens: number;
	/** Per-section token counts, in request order. */
	sectionTokens: Record<string, number>;
	truncated: BudgetResult["truncated"];
	tools: string[];
	at: number;
}

/**
 * Provider adapters annotate the blocks they send with `cache_control` and its ttl, in place. Those
 * keys are not part of what the model sees, so they must not count as the message changing: the
 * audit reported "message 0 changed after it was sent" on a request that was byte-identical, and
 * wrote the line over the input box.
 */
function stripSendMarkers(_key: string, value: unknown): unknown {
	return _key === "cache_control" ? undefined : value;
}

/**
 * The text a message contributes to the prompt, whatever shape it arrived in. A string and the
 * single text block that replaces it on the wire are the same prompt, and the compiler rewrites one
 * into the other in place: hashing the raw JSON reported a cache break on a request that was
 * identical, and printed the warning over the input box.
 */
function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? "", stripSendMarkers);
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object") {
				const text = (block as { text?: unknown }).text;
				if (typeof text === "string") return text;
			}
			return JSON.stringify(block, stripSendMarkers);
		})
		.join("\u0002");
}

function messageText(message: unknown): string {
	const candidate = message as { role?: string; content?: unknown } | undefined;
	const role = candidate?.role ?? "unknown";
	return `${role}\u0000${contentText(candidate?.content)}`;
}

function messageKey(message: unknown): string {
	return hash(messageText(message));
}

function sectionsKey(sections: Record<string, string>): string {
	// The order is the volatility order, so this hash covers both content and layout.
	return hash(Object.entries(sections).map(([name, text]) => `${name}\u0000${text}`).join("\u0001"));
}

function toolsKey(tools: readonly string[]): string {
	return hash(tools.join("\u0000"));
}

/** True when `previous` is a prefix of `next`. */
function isPrefix(previous: readonly string[], next: readonly string[]): boolean {
	if (previous.length > next.length) return false;
	return previous.every((value, index) => next[index] === value);
}

export interface ObserveInput {
	sections: Record<string, string>;
	tools: readonly string[];
	messages: readonly unknown[];
	breakReason?: CacheBreak;
	truncated?: BudgetResult["truncated"];
	/** Tokens that are not a prose section but still ride in the request, such as tool schemas. */
	extraTokens?: Record<string, number>;
}

/**
 * Compares each request with the one before it and reports what moved.
 *
 * The five stages of `docs/05` §4.2 are covered: `loadout` (tools), `sections` (prompt), `context`
 * and `shape` (messages), and `tool-delta` (tools may only be appended).
 */
export class RequestAuditor {
	private _previous?: RequestSnapshot;
	private _request = 0;
	private _history: RequestAudit[] = [];

	get history(): readonly RequestAudit[] {
		return this._history;
	}

	reset(): void {
		this._previous = undefined;
		this._request = 0;
		this._history = [];
	}

	/** Forget the previous snapshot without clearing history: a declared break, then continue. */
	invalidate(): void {
		this._previous = undefined;
	}

	observe(input: ObserveInput): RequestAudit {
		const sections = orderSections(input.sections);
		const sectionHashes: Record<string, string> = {};
		const sectionTokens: Record<string, number> = {};
		let tokens = 0;
		for (const [name, text] of Object.entries(sections)) {
			sectionHashes[name] = hash(text);
			sectionTokens[name] = estimateTokens(text);
			tokens += sectionTokens[name];
		}
		const extraTokens = { ...(input.extraTokens ?? {}) };
		for (const [name, value] of Object.entries(extraTokens)) {
			sectionTokens[name] = value;
			tokens += value;
		}
		const messages = input.messages.map(messageKey);
		const messageTokens = input.messages.map((message) => estimateTokens(messageText(message)));
		const tools = [...input.tools];
		const snapshot: RequestSnapshot = {
			sections: sectionHashes,
			tools,
			messages,
			messageTokens,
			extraTokens,
			prefix: hash(`${toolsKey(tools)}\u0001${sectionsKey(sections)}`),
			tokens,
			at: Date.now(),
		};

		const previous = this._previous;
		const breakReason = input.breakReason ?? (previous ? "none" : "first_request");
		const violations: string[] = [];
		let cacheablePrefixTokens = 0;

		if (previous && breakReason === "none") {
			for (const [name, value] of Object.entries(previous.sections)) {
				if (snapshot.sections[name] === value) continue;
				violations.push(
					snapshot.sections[name] === undefined
						? `section \`${name}\` was removed`
						: `section \`${name}\` changed (${previous.sections[name]} → ${snapshot.sections[name]})`,
				);
			}
			const added = Object.keys(snapshot.sections).filter((name) => previous.sections[name] === undefined);
			if (added.length > 0 && Object.keys(previous.sections).length > 0) {
				// Appending a section at the tail is legal; inserting one before an existing section is not.
				const order = Object.keys(snapshot.sections);
				const lastPrevious = Object.keys(previous.sections)[Object.keys(previous.sections).length - 1];
				const lastPreviousIndex = lastPrevious === undefined ? -1 : order.indexOf(lastPrevious);
				const insertedBefore = added.some((name) => order.indexOf(name) < lastPreviousIndex);
				if (insertedBefore) violations.push(`section(s) ${added.join(", ")} inserted before an existing section`);
			}
			if (!isPrefix(previous.tools, tools)) {
				violations.push(`tool declarations changed shape (${previous.tools.join(",")} → ${tools.join(",")})`);
			}
			if (!isPrefix(previous.messages, messages)) {
				const at = firstDivergence(previous.messages, messages);
				violations.push(`message ${at} changed after it was sent`);
			}
			// The cacheable prefix is what repeats byte for byte: unchanged sections plus the
			// conversation up to the first message that moved.
			const unchangedSections = Object.entries(snapshot.sections)
				.filter(([name, value]) => previous.sections[name] === value)
				.reduce((sum, [name]) => sum + (sectionTokens[name] ?? 0), 0);
			const diverged = firstDivergence(previous.messages, messages);
			const reusedMessages = previous.messageTokens.slice(0, diverged).reduce((sum, value) => sum + value, 0);
			// The tool block rides in the prefix too, so an unchanged tool set reuses its schemas.
			const reusedExtras = toolsKey(previous.tools) === toolsKey(tools)
				? Object.values(previous.extraTokens).reduce((sum, value) => sum + value, 0)
				: 0;
			cacheablePrefixTokens = unchangedSections + reusedMessages + reusedExtras;
		} else if (previous) {
			cacheablePrefixTokens = 0;
		}

		this._request += 1;
		const audit: RequestAudit = {
			request: this._request,
			appendOnly: violations.length === 0,
			breakReason,
			violations,
			cacheablePrefixTokens: Math.max(0, cacheablePrefixTokens),
			tokens,
			sectionTokens,
			truncated: input.truncated ?? [],
			tools,
			at: snapshot.at,
		};
		this._previous = snapshot;
		this._history.push(audit);
		if (this._history.length > 200) this._history.shift();
		return audit;
	}
}

function firstDivergence(previous: readonly string[], next: readonly string[]): number {
	const limit = Math.min(previous.length, next.length);
	for (let index = 0; index < limit; index += 1) {
		if (previous[index] !== next[index]) return index;
	}
	return limit;
}

/** A short line for the footer or a log. */
export function formatAudit(audit: RequestAudit): string {
	const state = audit.appendOnly ? "append-only" : `violation (${audit.breakReason})`;
	return `request ${audit.request} · ${audit.tokens} tok · cache ${audit.cacheablePrefixTokens} tok · ${state}`;
}
