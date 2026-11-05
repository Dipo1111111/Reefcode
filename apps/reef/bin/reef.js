#!/usr/bin/env node
// REEF's published entry point. It exists to do exactly one thing before the CLI starts: tell the
// core where its own package root is, so the version, config directory name and bundled assets are
// read from this install rather than guessed from the working directory.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(here);

if (!process.env.REEF_PACKAGE_DIR) process.env.REEF_PACKAGE_DIR = root;

const cli = join(root, "dist", "bundle", "cli.js");
try {
	await import(pathToFileURL(cli).href);
} catch (error) {
	if (error?.code === "ERR_MODULE_NOT_FOUND") {
		console.error(`reef: this install is incomplete — ${cli} is missing.`);
		console.error("reef: reinstall with `npm install -g reef-harness`.");
		process.exit(70);
	}
	throw error;
}
