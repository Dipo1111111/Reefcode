const fs = require("node:fs");

// Reads a user-supplied path and returns it as text.
function read(p) {
	return fs.readFileSync(p, "utf8");
}

module.exports = { read };
