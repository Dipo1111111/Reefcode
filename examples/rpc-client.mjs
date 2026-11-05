#!/usr/bin/env node
/**
 * A minimal RPC client, which is also the proof that an editor can drive REEF.
 *
 *   node examples/rpc-client.mjs --state
 *   node examples/rpc-client.mjs "what does this repo do?"
 *
 * It speaks the documented protocol: wait for `ready`, then send one command at a time and print the
 * responses and events it cares about. `--state` asks for the session state only, which costs nothing
 * and is the quickest way to check that a build still speaks the protocol.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const reef = join(here, "..", "apps", "reef", "bin", "reef");
const argv = process.argv.slice(2);
const stateOnly = argv.includes("--state");
const prompt = argv.filter((arg) => arg !== "--state").join(" ");

const child = spawn(reef, ["--mode", "rpc"], { stdio: ["pipe", "pipe", "inherit"] });

let buffered = "";
let nextId = 1;
const awaiting = new Map();
let ready = false;

const send = (command) => {
	const id = String(nextId++);
	child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
	return new Promise((resolve) => awaiting.set(id, resolve));
};

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffered += chunk;
	const lines = buffered.split("\n");
	buffered = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.trim()) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}

		if (message.type === "ready") {
			ready = true;
			// A client that speaks a different protocol stops here rather than guessing.
			if (message.protocol !== 1) {
				console.error(`protocol ${message.protocol}, this client speaks 1`);
				process.exit(2);
			}
			console.error(`ready: ${message.app} v${message.version} · protocol ${message.protocol}`);
			void begin();
			continue;
		}

		if (message.type === "response" && message.id && awaiting.has(message.id)) {
			const resolve = awaiting.get(message.id);
			awaiting.delete(message.id);
			resolve(message);
			continue;
		}

		if (message.type === "message_end" && message.message?.role === "assistant") {
			const text = (message.message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("");
			if (text.trim()) process.stdout.write(`${text.trim()}\n`);
			const usage = message.message.usage;
			if (usage) {
				console.error(
					`${usage.input ?? 0} in · ${usage.output ?? 0} out · ${usage.cacheRead ?? 0} cached · $${(usage.cost?.total ?? 0).toFixed(4)}`,
				);
			}
		}

		if (message.type === "agent_end") {
			child.stdin.end();
		}
	}
});

async function begin() {
	const state = await send({ type: "get_state" });
	if (state?.success) {
		const data = state.data ?? {};
		console.error(
			`model: ${data.model?.provider ?? "?"}/${data.model?.id ?? "?"} · messages: ${data.messageCount ?? 0} · session: ${data.sessionId ?? "?"}`,
		);
	}
	if (stateOnly) {
		child.stdin.end();
		return;
	}
	await send({ type: "prompt", message: prompt });
}

child.on("close", (code) => process.exit(code ?? 0));
setTimeout(() => {
	if (!ready) {
		console.error("no ready event; is this a REEF build with RPC?");
		child.kill();
		process.exit(5);
	}
}, 5000).unref();
