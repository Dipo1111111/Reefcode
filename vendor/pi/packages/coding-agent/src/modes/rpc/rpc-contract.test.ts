import { describe, expect, it } from "vitest";
import { RPC_COMMANDS, RPC_PROTOCOL_VERSION } from "./rpc-types.ts";

describe("RPC contract", () => {
	it("has a version to negotiate with", () => {
		expect(RPC_PROTOCOL_VERSION).toBe(1);
	});

	it("documents the commands a client is expected to send", () => {
		// A client that cannot see a command here will not try it, so a missing entry is a feature
		// that does not exist as far as an editor is concerned.
		for (const name of ["prompt", "abort", "get_state", "set_model", "get_session_stats", "bash"]) {
			expect(RPC_COMMANDS[name]).toBeDefined();
		}
	});

	it("gives every command a required-field list", () => {
		for (const [name, entry] of Object.entries(RPC_COMMANDS)) {
			expect(Array.isArray(entry.required), name).toBe(true);
			expect(entry.reply === "response" || entry.reply === "events", name).toBe(true);
		}
	});

	it("prompt really needs a message", () => {
		expect(RPC_COMMANDS.prompt?.required).toContain("message");
	});
});
