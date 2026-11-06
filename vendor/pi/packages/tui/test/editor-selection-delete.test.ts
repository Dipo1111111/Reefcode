import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function makeEditor(text: string): Editor {
	const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
	editor.setText(text);
	editor.render(80); // the render records wrapping width, padding, and visible rows
	return editor;
}

// Content rows: row 0 is the top border, so the first text line is row 1.
describe("Editor.deleteSelection", () => {
	it("deletes a selection within one line, and nothing else", () => {
		const editor = makeEditor("hello world");
		// columns 6..11 cover "world"
		assert.strictEqual(editor.deleteSelection({ start: { row: 1, col: 6 }, end: { row: 1, col: 11 } }), true);
		assert.strictEqual(editor.getText(), "hello ");
	});

	it("deletes across lines and joins the remainders", () => {
		const editor = makeEditor("alpha\nbeta\ngamma");
		// from "alpha" column 3 through "beta" column 2 (exclusive end at col 2 of beta)
		assert.strictEqual(editor.deleteSelection({ start: { row: 1, col: 3 }, end: { row: 2, col: 2 } }), true);
		assert.strictEqual(editor.getText(), "alpta\ngamma");
	});

	it("does nothing and reports false for an empty selection", () => {
		const editor = makeEditor("hello");
		assert.strictEqual(editor.deleteSelection({ start: { row: 1, col: 2 }, end: { row: 1, col: 2 } }), false);
		assert.strictEqual(editor.getText(), "hello");
	});

	it("is one undo step", () => {
		const editor = makeEditor("hello world");
		editor.deleteSelection({ start: { row: 1, col: 5 }, end: { row: 1, col: 11 } });
		assert.strictEqual(editor.getText(), "hello");
		editor.handleInput("\x1f"); // undo (ctrl+_)
		assert.strictEqual(editor.getText(), "hello world");
	});

	it("keeps the cursor at the start of the deleted range", () => {
		const editor = makeEditor("hello world");
		editor.deleteSelection({ start: { row: 1, col: 6 }, end: { row: 1, col: 11 } });
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 6 });
	});
});
