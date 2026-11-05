import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * The mark is a five-row block wordmark: square strokes, one cell of tracking, no artwork. It reads
 * as a name rather than a picture, which is what a startup screen needs — the input below is the
 * thing a user is looking for.
 *
 * Colours are fixed across themes and follow the terminal's colour mode.
 */
const RED_LIGHT = rgbColor(226, 74, 63);
const RED = rgbColor(190, 42, 36);
const RED_DEEP = rgbColor(140, 26, 24);
const RESET = "\x1b[0m";

const GLYPHS: Record<string, string[]> = {
	R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
	E: ["█████", "█    ", "████ ", "█    ", "█████"],
	F: ["█████", "█    ", "████ ", "█    ", "█    "],
};

/** One colour per letter, so the word reads left to right without a gradient dependency. */
const LETTER_COLOURS = [RED_LIGHT, RED_LIGHT, RED, RED_DEEP];

/** Five lines, roughly 23 cells wide. */
export function reefLogoLines(): string[] {
	// The startup header is built while the terminal is still reporting its capabilities, so the
	// accent may not be resolved yet. Plain blocks are better than no mark at all.
	let mode: Parameters<typeof foregroundAnsi>[1];
	try {
		mode = theme.getColorMode();
	} catch {
		return ["████  █████ █████ █████", "█   █ █     █     █    ", "████  ████  ████  ████ ", "█  █  █     █     █    ", "█   █ █████ █████ █    "];
	}
	const rows: string[] = [];
	for (let row = 0; row < 5; row += 1) {
		let line = "";
		"REEF".split("").forEach((letter, index) => {
			const glyph = GLYPHS[letter]?.[row] ?? "";
			const colour = foregroundAnsi(LETTER_COLOURS[index] ?? RED, mode);
			line += colour + glyph + RESET + " ";
		});
		rows.push(line.trimEnd());
	}
	return rows;
}

/**
 * Apple Terminal draws gaps between rows and misaligns the blocks, so it gets the text wordmark.
 */
export function supportsReefLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback: REEF in the accent colour. */
export function reefWordmark(): string {
	try {
		return `${foregroundAnsi(RED_LIGHT, theme.getColorMode())}REEF${RESET}`;
	} catch {
		return "REEF";
	}
}

/** Kept for the 3D easter egg's anchor cell. */
export function reefLogoBackground(): string {
	return backgroundAnsi(RED_DEEP, theme.getColorMode());
}
