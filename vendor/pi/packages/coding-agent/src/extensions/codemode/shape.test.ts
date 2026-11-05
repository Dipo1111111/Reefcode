import { describe, expect, it } from "vitest";
import { createCodemodeDescription } from "./tool.ts";

const edit = {
	name: "edit",
	description: "Edit a file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string" },
			edits: {
				type: "array",
				items: {
					type: "object",
					properties: { oldText: { type: "string" }, newText: { type: "string" } },
					required: ["oldText", "newText"],
				},
			},
		},
		required: ["path", "edits"],
	},
} as never;

describe("the compact listing shows argument shape", () => {
	it("names the fields inside an array, so a caller does not guess the edit spelling", () => {
		const text = createCodemodeDescription([edit], { compact: true });
		expect(text).toContain("edits: [{ oldText, newText }]");
	});
});
