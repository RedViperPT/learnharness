"use strict";
const fs = require("node:fs");
const path = require("node:path");

/** Before the owned server starts: only this feature's private scratch space. */
function cleanPdfStaging(dataDir) {
	const staging = path.join(dataDir, "pdf-extraction-staging");
	if (fs.existsSync(staging) && fs.lstatSync(staging).isSymbolicLink()) throw new Error("PDF staging must not be a symlink.");
	fs.rmSync(staging, { recursive: true, force: true });
}
module.exports = { cleanPdfStaging };
