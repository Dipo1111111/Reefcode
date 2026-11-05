import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/** Reef teal, the single accent (docs/17 §3). */
const TEAL = rgbColor(94, 200, 192);
const DEEP = rgbColor(48, 122, 118);
const RESET = "\x1b[0m";

/**
 * The reef mark: 4 cells wide and 2 lines tall, built from half blocks.
 *
 *   ▄▄▄▄      the surface
 *   █▄▄█      what is under it
 *
 * Colours are fixed across themes and follow the terminal's colour mode.
 */
export function reefLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof TEAL) => foregroundAnsi(color, mode);
	const bg = (color: typeof DEEP) => backgroundAnsi(color, mode);
	const top = `${fg(TEAL)}▄▄▄▄${RESET}`;
	const bottom = `${fg(DEEP)}█${RESET}${bg(TEAL)}  ${RESET}${fg(DEEP)}█${RESET}`;
	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block mark correctly. Apple Terminal draws gaps between
 * rows and misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsReefLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback: REEF in the accent colour and a dimmer second half. */
export function reefWordmark(): string {
	const mode = theme.getColorMode();
	const fg = (color: typeof TEAL) => foregroundAnsi(color, mode);
	return `${fg(TEAL)}REEF${RESET}`;
}
