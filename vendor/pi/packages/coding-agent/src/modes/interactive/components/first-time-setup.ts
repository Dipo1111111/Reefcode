import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import { APP_NAME } from "../../../config.ts";
import { SYSTEM_THEME_NAME } from "../theme/system-theme.ts";
import { theme } from "../theme/theme.ts";
import { reefLogoLines, reefWordmark, supportsReefLogo } from "./reef-logo.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface FirstTimeSetupResult {
	theme: string;
	shareAnalytics: boolean;
}

export interface FirstTimeSetupOptions {
	onThemePreview: (themeName: string) => void;
	onSubmit: (result: FirstTimeSetupResult) => void;
	onCancel: () => void;
}

const THEME_OPTIONS: Array<{ value: string; label: string }> = [
	{ value: SYSTEM_THEME_NAME, label: "System (matches your terminal colors)" },
	{ value: "dark", label: "Dark" },
	{ value: "light", label: "Light" },
];

/** First-time setup: one question, the theme. REEF records nothing, so nothing is asked about. */
export class FirstTimeSetupComponent extends Container {
	/** REEF asks one question: which theme. There is no telemetry, so there is nothing to opt into. */
	private step: "theme" = "theme";
	private themeIndex: number;
	private readonly options: FirstTimeSetupOptions;

	constructor(options: FirstTimeSetupOptions) {
		super();
		this.options = options;
		this.themeIndex = 0;
		this.update();
	}

	/** Rebuild on theme changes, e.g. when the system theme receives the terminal's colors. */
	override invalidate(): void {
		this.update();
		super.invalidate();
	}

	// Rebuild the whole dialog on every change so theme previews recolor all text.
	private update(): void {
		this.clear();
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		// The same mark the header uses, so the first screen and every later one agree.
		this.addChild(new Text(supportsReefLogo() ? reefLogoLines().join("\n") : reefWordmark(), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Welcome to ${APP_NAME}.`)) +
					"\n" +
					theme.fg("muted", "One script, many tool calls. Pick a theme; nothing else is asked."),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.addChild(new Text(theme.fg("text", "Pick a theme. Enter to start."), 1, 0));
		this.addChild(new Spacer(1));
		this.addOptionList(
			THEME_OPTIONS.map((option) => option.label),
			this.themeIndex,
		);

		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "start") +
					"  " +
					keyHint("tui.select.cancel", "skip setup"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	private addOptionList(labels: string[], selectedIndex: number): void {
		for (let i = 0; i < labels.length; i++) {
			const isSelected = i === selectedIndex;
			const prefix = isSelected ? theme.fg("accent", "→ ") : "  ";
			const label = isSelected ? theme.fg("accent", labels[i]) : theme.fg("text", labels[i]);
			this.addChild(new Text(`${prefix}${label}`, 1, 0));
		}
	}

	private moveSelection(delta: number): void {
		if (this.step === "theme") {
			const next = Math.max(0, Math.min(THEME_OPTIONS.length - 1, this.themeIndex + delta));
			if (next !== this.themeIndex) {
				this.themeIndex = next;
				this.options.onThemePreview(THEME_OPTIONS[this.themeIndex].value);
			}
		}
		this.update();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.moveSelection(-1);
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.moveSelection(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.options.onSubmit({
				theme: THEME_OPTIONS[this.themeIndex].value,
				// No telemetry, so nothing is shared. The field stays because the caller's type has it.
				shareAnalytics: false,
			});
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.options.onCancel();
		}
	}
}
