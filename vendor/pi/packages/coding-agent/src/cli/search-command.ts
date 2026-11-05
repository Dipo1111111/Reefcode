/**
 * `reef search "term"` — find something you said or the agent read, across sessions.
 *
 * Session files are JSONL, so this is a scan, not an index. That is the right trade at this size:
 * fifty sessions are a few megabytes, and an index would be a second thing to keep consistent.
 *
 * It searches the text a human would remember: user and assistant messages, and tool output. It
 * does not search tool arguments, which are mostly paths and would drown the matches.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SearchMatch {
	session: string;
	path: string;
	role: string;
	line: number;
	snippet: string;
}

export interface SearchOptions {
	query: string;
	dirs: string[];
	/** Case-sensitive when true. Default: false, because people search from memory. */
	caseSensitive?: boolean;
	limit?: number;
	/** Filter to one session id or file name. */
	session?: string;
}

const SNIPPET_RADIUS = 90;

function snippetAround(text: string, query: string, caseSensitive: boolean): string | undefined {
	const haystack = caseSensitive ? text : text.toLowerCase();
	const needle = caseSensitive ? query : query.toLowerCase();
	const at = haystack.indexOf(needle);
	if (at < 0) return undefined;
	const start = Math.max(0, at - SNIPPET_RADIUS);
	const end = Math.min(text.length, at + query.length + SNIPPET_RADIUS);
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function collectSessions(dirs: readonly string[]): string[] {
	const files: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir)) {
			if (name.endsWith(".jsonl")) files.push(join(dir, name));
		}
	}
	return files.sort();
}

/** Text of an entry, or undefined when it has no human-readable content. */
function textOf(entry: unknown): { role: string; text: string } | undefined {
	const record = entry as { type?: string; message?: { role?: string; content?: unknown }; data?: unknown };
	if (record.type !== "message" || !record.message) return undefined;
	const role = record.message.role ?? "unknown";
	if (role !== "user" && role !== "assistant") return undefined;
	const content = record.message.content;
	if (typeof content === "string") return { role, text: content };
	if (!Array.isArray(content)) return undefined;
	const text = content
		.map((part) => {
			const candidate = part as { type?: string; text?: string };
			return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
		})
		.join("\n");
	return text.trim() ? { role, text } : undefined;
}

export function searchSessions(options: SearchOptions): SearchMatch[] {
	const caseSensitive = options.caseSensitive === true;
	const limit = options.limit ?? 50;
	const matches: SearchMatch[] = [];

	for (const path of collectSessions(options.dirs)) {
		if (options.session && !path.includes(options.session)) continue;
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		const session = path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path;
		const lines = raw.split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index]!;
			if (!line.trim().startsWith("{")) continue;
			// Cheap rejection before parsing: most lines do not contain the query at all.
			const probe = caseSensitive ? line : line.toLowerCase();
			if (!probe.includes(caseSensitive ? options.query : options.query.toLowerCase())) continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			const text = textOf(entry);
			if (!text) continue;
			const snippet = snippetAround(text.text, options.query, caseSensitive);
			if (!snippet) continue;
			matches.push({ session, path, role: text.role, line: index + 1, snippet });
			if (matches.length >= limit) return matches;
		}
	}
	return matches;
}

export function formatMatches(matches: readonly SearchMatch[]): string {
	if (matches.length === 0) return "No matches.";
	return matches.map((match) => `${match.session}  ${match.role.padEnd(9)} ${match.snippet}`).join("\n");
}

const HELP = `reef search — find text across this project's sessions.

  reef search "migration"
  reef search "ECONNREFUSED" --session 2026-11-05
  reef search "policy_block" --json --limit 10

  --session <id>   only this session
  --limit <n>      stop after n matches (default 50)
  --case           match case exactly
  --json           one JSON object per match
  --dir <path>     an extra session directory to scan

Exit codes: 0 matches found · 1 none · 2 bad usage
`;

export interface SearchCommandResult {
	handled: boolean;
	exitCode?: number;
}

/** `reef search …`, reading sessions from the project and the agent directory. */
export function runSearchCommand(args: readonly string[]): SearchCommandResult {
	if (args[0] !== "search") return { handled: false };
	const argv = args.slice(1);
	const query: string[] = [];
	const dirs: string[] = [];
	let session: string | undefined;
	let limit = 50;
	let caseSensitive = false;
	let json = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--help" || arg === "-h") {
			process.stdout.write(HELP);
			return { handled: true, exitCode: 0 };
		}
		if (arg === "--session") session = argv[++index];
		else if (arg === "--dir") {
			const dir = argv[++index];
			if (dir) dirs.push(dir);
		} else if (arg === "--limit") {
			const value = Number(argv[++index]);
			if (!Number.isFinite(value) || value <= 0) {
				process.stderr.write("search: --limit must be a positive number\n");
				return { handled: true, exitCode: 2 };
			}
			limit = value;
		} else if (arg === "--case") caseSensitive = true;
		else if (arg === "--json") json = true;
		else if (arg.startsWith("-")) {
			process.stderr.write(`search: unknown flag \`${arg}\`\n`);
			return { handled: true, exitCode: 2 };
		} else query.push(arg);
	}

	if (query.length === 0) {
		process.stderr.write("search: give something to search for\n");
		return { handled: true, exitCode: 2 };
	}

	const searchDirs = [join(process.cwd(), ".reef", "sessions"), ...dirs];
	const agentDir = process.env.REEF_AGENT_DIR ?? join(process.env.HOME ?? "", ".reef", "agent");
	searchDirs.push(join(agentDir, "sessions"));

	const matches = searchSessions({ query: query.join(" "), dirs: searchDirs, limit, caseSensitive, session });
	if (json) {
		for (const match of matches) process.stdout.write(`${JSON.stringify(match)}\n`);
	} else {
		process.stdout.write(`${formatMatches(matches)}\n`);
	}
	return { handled: true, exitCode: matches.length > 0 ? 0 : 1 };
}

export default runSearchCommand;
