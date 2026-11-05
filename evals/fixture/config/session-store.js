const fs = require("node:fs");
const path = require("node:path");

// Appends one entry per line to the session file.
function writeSessionEntry(sessionPath, entry) {
	fs.appendFileSync(path.resolve(sessionPath), `${JSON.stringify(entry)}\n`);
}

module.exports = { writeSessionEntry };
