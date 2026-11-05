import { describe, expect, it } from "vitest";
import { InlineCodemodeSandbox, loadQuickJSWasm } from "../src/index.ts";

function sandbox(): InlineCodemodeSandbox {
	return new InlineCodemodeSandbox({
		tools: [],
		globals: [],
		timeoutMs: 5000,
		memoryLimitBytes: 64 * 1024 * 1024,
		wasm: loadQuickJSWasm(),
		interruptBudget: 100000,
	} as never);
}

async function run(source: string): Promise<unknown> {
	const result = await sandbox().execute(source);
	if (!result.ok) throw new Error(JSON.stringify(result));
	return result.value;
}

describe("script text codec", () => {
	it("measures bytes, which is how a script keeps a file under a size cap", async () => {
		expect(await run(`return new TextEncoder().encode("abc").length`)).toBe(3);
		expect(await run(`return new TextEncoder().encode("é").length`)).toBe(2);
		expect(await run(`return new TextEncoder().encode("€").length`)).toBe(3);
		expect(await run(`return new TextEncoder().encode("🙂").length`)).toBe(4);
	});

	it("replaces a lone surrogate instead of emitting an invalid byte", async () => {
		expect(await run(`return new TextEncoder().encode("\\ud800").length`)).toBe(3);
	});

	it("round-trips text through the codec", async () => {
		const value = await run(
			`const text = "café — 🙂 \\u00a0ok"; const bytes = new TextEncoder().encode(text); return new TextDecoder().decode(bytes) === text`,
		);
		expect(value).toBe(true);
	});

	it("throws on malformed input only when fatal is set", async () => {
		expect(await run(`return new TextDecoder().decode(new Uint8Array([0xff]))`)).toBe("\ufffd");
		expect(await run(`try { new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array([0xff])); return "no throw" } catch (error) { return error.name }`)).toBe(
			"TypeError",
		);
	});

	it("strips a byte-order mark unless asked to keep it", async () => {
		expect(await run(`return new TextDecoder().decode(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))`)).toBe("a");
	});
});
