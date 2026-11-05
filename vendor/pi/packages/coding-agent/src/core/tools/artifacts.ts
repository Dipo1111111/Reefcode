/**
 * Durable artifacts for output that did not fit in the transcript.
 *
 * A truncated tool result keeps its first or last slice in the conversation and points at the rest.
 * A temp file is a fine pointer until the machine reboots; `.reef/artifacts/` is a pointer the model
 * can come back to in the next session, and a file the user can open.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Paths we have already published, so a re-render does not write the file twice. */
const published = new Map<string, string>();

function artifactsDir(cwd: string): string | undefined {
	const dir = join(cwd, ".reef", "artifacts");
	try {
		mkdirSync(dir, { recursive: true });
		return dir;
	} catch {
		return undefined;
	}
}

/**
 * Copy a temp file into `.reef/artifacts` and return the path to show the model, or undefined.
 *
 * `dedupeKey` identifies the output rather than the temp file: a result is rendered more than once
 * (progress, then final) and each render re-reads the accumulator into a fresh temp file.
 */
export function publishArtifact(cwd: string, tool: string, sourcePath: string, dedupeKey?: string): string | undefined {
	const key = dedupeKey ?? sourcePath;
	const cached = published.get(key);
	if (cached) return cached;
	if (!existsSync(sourcePath)) return undefined;
	const dir = artifactsDir(cwd);
	if (!dir) return undefined;
	const name = `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`;
	const target = join(dir, name);
	try {
		copyFileSync(sourcePath, target);
	} catch {
		return undefined;
	}
	const relative = join(".reef", "artifacts", name);
	published.set(key, relative);
	return relative;
}

/** Write content straight into `.reef/artifacts` and return the path to show the model. */
export function writeArtifact(cwd: string, tool: string, content: string): string | undefined {
	const dir = artifactsDir(cwd);
	if (!dir) return undefined;
	const name = `${tool}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.txt`;
	try {
		writeFileSync(join(dir, name), content, "utf8");
	} catch {
		return undefined;
	}
	return join(".reef", "artifacts", name);
}
