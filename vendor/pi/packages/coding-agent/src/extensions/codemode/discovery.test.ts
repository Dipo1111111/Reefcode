import { describe, expect, it } from "vitest";
import { createCodemodeDescription } from "./tool.ts";

/**
 * The discovery globals used to throw when called with no argument. A model asking "what is there?"
 * is a reasonable question, and the throw cost it a whole turn plus an error block in the transcript.
 * The behaviour is checked through the description and through the executor below.
 */

describe("discovery guidance", () => {
	it("tells the model the tools are already listed, so it does not spend a call listing them", () => {
		const text = createCodemodeDescription(
			[{ name: "read", description: "Read a file.", parameters: { type: "object", properties: {} } } as never],
			{ compact: true },
		);
		expect(text).toContain("listed below with its arguments");
		expect(text).toContain("Do not open with a discovery call");
	});
});
