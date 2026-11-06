import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { Text } from "../src/components/text.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("selection delete through the alt screen", () => {
	it("Backspace over a mouse-selected range deletes the range, not one character", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		// Drag across "world" (text columns 6..10 on the first text row, screen row 1).
		terminal.sendInput("\x1b[<0;7;2M"); // press at column 6
		terminal.sendInput("\x1b[<32;11;2M"); // drag to column 10 (inclusive)
		terminal.sendInput("\x1b[<3;11;2m"); // release
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x7f"); // Backspace
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(editor.getText(), "hello ");
		tui.stop();
	});

	it("deletes a range dragged right-to-left over the input", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x1b[<0;11;2M"); // press on the last column of "world"
		terminal.sendInput("\x1b[<32;7;2M"); // drag left onto its first column
		terminal.sendInput("\x1b[<3;7;2m");
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x7f");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.strictEqual(editor.getText(), "hello ");
		tui.stop();
	});

	it("leaves a transcript selection to the transcript, not to the input", async () => {
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
		tui.addChild(new Text("transcript output here", 0, 0));
		const editor = new Editor(tui, defaultEditorTheme);
		editor.setText("ab");
		tui.addChild(editor);
		tui.setFocus(editor);
		tui.start();
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x1b[<0;1;1M"); // press on the transcript, not the input
		terminal.sendInput("\x1b[<32;10;1M");
		terminal.sendInput("\x1b[<3;10;1m");
		await new Promise((resolve) => setTimeout(resolve, 20));

		terminal.sendInput("\x7f");
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The input keeps its normal single-character Backspace; the transcript selection is not its text.
		assert.strictEqual(editor.getText(), "a");
		tui.stop();
	});
});
