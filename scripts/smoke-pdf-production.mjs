/** Test the traced production server, not the repo's development modules.
 * Usage: node scripts/smoke-pdf-production.mjs <standalone/server.js> */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";

const entry = process.argv[2]; assert.ok(entry, "Pass the standalone server.js path");
const temp = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir(), "pdf-production-smoke-"));
const data = path.join(temp, "data"); await fs.mkdir(data);
const source = path.join(temp, "Source.pdf"); const pdf = await PDFDocument.create();
for (let i = 1; i <= 3; i++) pdf.addPage([200 + i, 300]);
await fs.writeFile(source, await pdf.save());
const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const secret = randomBytes(32).toString("hex");
const server = spawn(process.execPath, [path.resolve(entry)], { cwd: path.dirname(path.resolve(entry)), env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), LH_DATA_DIR: data, LH_AUTH_FILE: path.join(temp, "auth.json"), LH_DESKTOP_SERVER: "1", LH_DESKTOP_API_SECRET: secret }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; const capture = value => { logs += value; }; server.stdout.on("data", capture); server.stderr.on("data", capture);
const url = `http://127.0.0.1:${port}/api/pdf-extractions`;
try {
	await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Production startup timed out")), 30000); const ready = () => { if (logs.includes("Ready in")) { clearTimeout(timer); resolve(); } }; server.stdout.on("data", ready); server.once("exit", code => { clearTimeout(timer); reject(new Error(`Production server exited ${code}`)); }); ready(); });
	const request = (body, authenticated = true) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(authenticated ? { "x-learnharness-desktop": secret } : {}) }, body: JSON.stringify(body) });
	const id = randomUUID();
	assert.equal((await request({ id, action: "cancel" }, false)).status, 403);
	const inspected = await request({ id, action: "start", items: [{ path: source, pdf: true }] }); assert.equal(inspected.status, 200, await inspected.clone().text()); assert.deepEqual(await inspected.json(), [{ pages: 3 }]);
	const image = await request({ id, action: "preview", index: 0, page: 2 }); assert.equal(image.status, 200, image.status !== 200 ? await image.text() : "");
	assert.equal(Buffer.from(await image.arrayBuffer()).subarray(1, 4).toString(), "PNG", "native PDF.js/canvas runtime is traced");
	const selections = [{ index: 0, mode: "extract", ranges: "3, 1", name: "Production.pdf" }];
	assert.deepEqual(await (await request({ id, action: "prepare", selections })).json(), {});
	const committed = await request({ id, action: "commit", selections }); assert.equal(committed.status, 200, await committed.clone().text());
	const [output] = await committed.json(); assert.ok(output.startsWith(path.join(data, "pdf-extracts")));
	const extracted = await PDFDocument.load(await fs.readFile(output)); assert.equal(extracted.getPageCount(), 2); assert.equal(extracted.getPage(0).getWidth(), 201); assert.equal(extracted.getPage(1).getWidth(), 203);
	console.log(JSON.stringify({ passed: true, desktopAuthorization: true, nativePreview: true, extractedPages: 2, data }, null, 2));
} catch (error) { console.error(logs); throw error; }
finally { if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} } else server.kill(); }
