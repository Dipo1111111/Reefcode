import { describe, expect, it } from "vitest";
import { formatMatches, searchSessions } from "./search-command.ts";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function session(lines: unknown[]): string {
	const dir = mkdtempSync(join(tmpdir(), "reef-search-"));
	const path = join(dir, "2026-11-05_abc.jsonl");
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
	return dir;
}

const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolResult = (text: string) => ({ type: "message", message: { role: "tool", content: [{ type: "text", text }] } });

describe("searchSessions", () => {
	it("finds a phrase in a user message and quotes it", () => {
		const dir = session([user("the migration keeps failing on index creation")]);
		const matches = searchSessions({ query: "migration", dirs: [dir] });
		expect(matches).toHaveLength(1);
		expect(matches[0]?.role).toBe("user");
		expect(matches[0]?.snippet).toContain("migration keeps failing");
	});

	it("is case-insensitive unless asked otherwise", () => {
		const dir = session([assistant("ECONNREFUSED")]);
		expect(searchSessions({ query: "econnrefused", dirs: [dir] })).toHaveLength(1);
		expect(searchSessions({ query: "econnrefused", dirs: [dir], caseSensitive: true })).toHaveLength(0);
	});

	it("skips tool results, which are mostly paths", () => {
		const dir = session([toolResult("src/migration.ts:12")]);
		expect(searchSessions({ query: "migration", dirs: [dir] })).toHaveLength(0);
	});

	it("ignores lines that are not JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "reef-search-"));
		writeFileSync(join(dir, "x.jsonl"), 'not json\n{"type":"message","message":{"role":"user","content":"migration"}}\n');
		expect(searchSessions({ query: "migration", dirs: [dir] })).toHaveLength(1);
	});

	it("respects the limit", () => {
		const dir = session([user("hit"), user("hit"), user("hit")]);
		expect(searchSessions({ query: "hit", dirs: [dir], limit: 2 })).toHaveLength(2);
	});

	it("filters to one session", () => {
		const dir = session([user("alpha")]);
		expect(searchSessions({ query: "alpha", dirs: [dir], session: "nope" })).toHaveLength(0);
		expect(searchSessions({ query: "alpha", dirs: [dir], session: "2026-11-05" })).toHaveLength(1);
	});

	it("a missing directory is empty, not a crash", () => {
		expect(searchSessions({ query: "x", dirs: ["/does/not/exist"] })).toEqual([]);
	});
});

describe("formatMatches", () => {
	it("says so when nothing matched", () => {
		expect(formatMatches([])).toBe("No matches.");
	});

	it("puts the session first so a list is scannable", () => {
		const text = formatMatches([{ session: "s1", path: "/x", role: "user", line: 1, snippet: "hello" }]);
		expect(text.startsWith("s1")).toBe(true);
	});
});
