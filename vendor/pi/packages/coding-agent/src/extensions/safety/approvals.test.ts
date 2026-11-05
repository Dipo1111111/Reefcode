import { describe, expect, it, vi } from "vitest";
import { ApprovalBatcher, type ApprovalRequest, describeBatch } from "./approvals.ts";

const request = (summary: string, tool = "bash"): ApprovalRequest => ({ summary, reason: "builtin/remote-write", tool });

describe("ApprovalBatcher", () => {
	it("shows one dialog for calls that arrive together", async () => {
		const confirm = vi.fn(async (_requests: readonly ApprovalRequest[]) => true);
		const batcher = new ApprovalBatcher({ confirm, schedule: () => {} });
		const first = batcher.ask(request("git push origin main"));
		const second = batcher.ask(request("git push origin dev"));
		expect(batcher.size).toBe(2);
		await batcher.flush();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(confirm.mock.calls[0]?.[0]).toHaveLength(2);
		expect(await first).toBe(true);
		expect(await second).toBe(true);
	});

	it("a denial denies every request in the batch", async () => {
		const batcher = new ApprovalBatcher({ confirm: async () => false, schedule: () => {} });
		const first = batcher.ask(request("a"));
		const second = batcher.ask(request("b"));
		await batcher.flush();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
	});

	it("a dialog that throws denies, because the safe direction is the one that stops", async () => {
		const batcher = new ApprovalBatcher({
			confirm: async () => {
				throw new Error("ui is gone");
			},
			schedule: () => {},
		});
		const asked = batcher.ask(request("rm -rf build"));
		await batcher.flush();
		expect(await asked).toBe(false);
	});

	it("a lone ask still gets its own dialog", async () => {
		const confirm = vi.fn(async (_requests: readonly ApprovalRequest[]) => true);
		const batcher = new ApprovalBatcher({ confirm, schedule: () => {} });
		const asked = batcher.ask(request("npm publish"));
		await batcher.flush();
		expect(confirm).toHaveBeenCalledTimes(1);
		expect(await asked).toBe(true);
	});

	it("schedules exactly one flush for a burst", async () => {
		const run: (() => void)[] = [];
		const batcher = new ApprovalBatcher({ confirm: async () => true, schedule: (fn) => run.push(fn) });
		batcher.ask(request("a"));
		batcher.ask(request("b"));
		batcher.ask(request("c"));
		expect(run).toHaveLength(1);
		await batcher.flush();
		expect(batcher.size).toBe(0);
	});

	it("an empty flush does nothing", async () => {
		const confirm = vi.fn(async (_requests: readonly ApprovalRequest[]) => true);
		const batcher = new ApprovalBatcher({ confirm, schedule: () => {} });
		await batcher.flush();
		expect(confirm).not.toHaveBeenCalled();
	});
});

describe("describeBatch", () => {
	it("names the tool and the reason for one call", () => {
		const { title, body } = describeBatch([request("git push origin main")]);
		expect(title).toBe("Allow this bash call?");
		expect(body).toContain("git push origin main");
		expect(body).toContain("builtin/remote-write");
	});

	it("numbers the calls and shares a common reason", () => {
		const { title, body } = describeBatch([request("one"), request("two"), request("three")]);
		expect(title).toBe("Allow 3 calls?");
		expect(body).toContain("1. bash: one");
		expect(body).toContain("3. bash: three");
		expect(body).toContain("builtin/remote-write");
	});

	it("says so when several rules apply", () => {
		const { body } = describeBatch([
			request("one"),
			{ summary: "two", reason: "builtin/force-push", tool: "bash" },
		]);
		expect(body).toContain("Several rules apply.");
	});
});
