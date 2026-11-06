/** Cross-platform test boot. Every test worker gets its own fallback data
 * directory BEFORE static imports load config.ts. Explicit per-test fixtures
 * may still replace LH_DATA_DIR. Never run tests against a learner's data. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.NODE_ENV = "test";
if (process.env.NODE_TEST_CONTEXT) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-worker-"));
	process.env.LH_DATA_DIR = directory;
	process.env.LH_AUTH_FILE = path.join(directory, "auth.json");
	process.once("exit", () => { fs.rmSync(directory, { recursive: true, force: true }); });
}
