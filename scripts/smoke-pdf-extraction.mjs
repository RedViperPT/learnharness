/** Real local PDF processing + browser UI. The Electron path bridge is mocked;
 * no providers, learner files, or installed desktop app are used. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { PDFDocument, StandardFonts } from "pdf-lib";
import puppeteer from "puppeteer-core";

const root = path.resolve(import.meta.dirname, "..");
const temp = await fs.mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp", "opencode") : os.tmpdir(), "pdf-ui-"));
const data = path.join(temp, "data"); await fs.mkdir(data);
const source = path.join(temp, "Textbook.pdf");
const original = await PDFDocument.create(); const font = await original.embedFont(StandardFonts.Helvetica);
for (let page = 1; page <= 5; page++) original.addPage([400, 500]).drawText(`Physical page ${page}`, { x: 30, y: 400, font });
await fs.writeFile(source, await original.save());
const notes = path.join(temp, "notes.txt"); await fs.writeFile(notes, "Synthetic notes");
const require = createRequire(import.meta.url);
const { getFontAxes } = require("next/dist/compiled/@next/font/dist/google/get-font-axes.js");
const { getGoogleFontsUrl } = require("next/dist/compiled/@next/font/dist/google/get-google-fonts-url.js");
const fonts = Object.fromEntries(["JetBrains Mono", "Source Sans 3"].map(family => [getGoogleFontsUrl(family, getFontAxes(family, ["variable"], ["normal"]), "swap"), `@font-face { font-family: '${family}'; src: local('Arial'); font-weight: 100 900; }`]));
await fs.writeFile(path.join(temp, "fonts.cjs"), `module.exports = ${JSON.stringify(fonts)};`);
const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env: { ...process.env, LH_DATA_DIR: data, LH_AUTH_FILE: path.join(temp, "auth.json"), LH_IGNORE_ENV_KEYS: "1", NEXT_TELEMETRY_DISABLED: "1", NEXT_FONT_GOOGLE_MOCKED_RESPONSES: path.join(temp, "fonts.cjs") }, stdio: ["ignore", "pipe", "pipe"] });
let logs = ""; const capture = chunk => { logs = (logs + chunk).slice(-30000); }; server.stdout.on("data", capture); server.stderr.on("data", capture);
let browser, page;
try {
	await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Server start timeout")), 90000); const ready = () => { if (logs.includes("Ready in")) { clearTimeout(timer); server.stdout.off("data", ready); resolve(); } }; server.stdout.on("data", ready); server.once("exit", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); }); });
	const candidates = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"];
	let executablePath; for (const candidate of candidates.filter(Boolean)) { try { await fs.access(candidate); executablePath = candidate; break; } catch {} }
	assert.ok(executablePath, "Set CHROME_PATH to Chrome/Edge");
	browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1200, height: 900 } });
	page = await browser.newPage(); page.setDefaultTimeout(20000);
	const errors = []; page.on("pageerror", error => errors.push(error.message));
	const model = { id: "synthetic", name: "Synthetic", provider: "fixture", input: ["text"], reasoning: false, supportedLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
	const slot = { model: { provider: model.provider, id: model.id }, thinkingLevel: "off" };
	await page.setRequestInterception(true);
	page.on("request", async request => {
		const url = new URL(request.url());
		if (url.origin !== origin && url.protocol !== "blob:") return request.abort();
		if (url.pathname === "/api/events") return request.respond({ status: 204 });
		if (url.pathname === "/api/models") return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [model], providers: [{ id: "fixture", label: "Fixture", keyPresent: true }], defaults: null, slots: { strong: slot, cheap: slot, vision: slot }, rolePins: {} }) });
		await request.continue();
	});
	await page.evaluateOnNewDocument(() => { window.lh = { getPathForFile: file => file.name }; });
	await page.goto(origin, { waitUntil: "domcontentloaded" });
	await page.waitForSelector("[data-file-path-input]");
	await page.waitForSelector('[data-testid="file-path-drop-zone"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="setup-cta"]') && !document.querySelector('[data-testid="setup-cta-keys"]'));
	async function drop() {
		await page.evaluate((paths) => {
			const editor = document.querySelector("[data-file-path-input]"); editor.focus();
			const transfer = new DataTransfer(); for (const source of paths) transfer.items.add(new File(["bridge-path-only"], source));
			document.querySelector('[data-testid="file-path-drop-zone"]').dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
		}, [source, notes]);
		await page.waitForSelector('[role="dialog"][aria-label="Attach PDF pages"]');
		await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes("5 PDF pages"));
	}
	await drop();
	await page.waitForSelector('[role="dialog"] img');
	await page.select('[role="dialog"] select', "extract");
	await page.type('input[placeholder="3–8, 12"]', "5, 2–3, 3");
	await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes("2–3, 5 (3 pages)"));
	const nameInput = '[role="dialog"] input:not([type="number"]):not([placeholder])';
	await page.click(nameInput); const modifier = process.platform === "darwin" ? "Meta" : "Control"; await page.keyboard.down(modifier); await page.keyboard.press("KeyA"); await page.keyboard.up(modifier); await page.type(nameInput, "Custom extract");
	await page.screenshot({ path: path.join(temp, "pdf-dialog.png") });
	await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "Apply").click());
	await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Attach PDF pages"]'));
	let draft = await page.$eval("[data-file-path-input]", element => element.textContent);
	assert.match(draft, /Custom extract.pdf/); assert.match(draft, /notes.txt/);
	const hashes = await fs.readdir(path.join(data, "pdf-extracts")); assert.equal(hashes.length, 1);
	const output = path.join(data, "pdf-extracts", hashes[0], "Custom extract.pdf");
	assert.equal((await PDFDocument.load(await fs.readFile(output))).getPageCount(), 3);
	// Exercise the shared file-picker entry point too, with the same bytes/name.
	await page.evaluate(source => {
		const picker = document.querySelector('[data-testid="attach-files-input"]');
		const transfer = new DataTransfer(); transfer.items.add(new File(["path only"], source));
		picker.files = transfer.files; picker.dispatchEvent(new Event("change", { bubbles: true }));
	}, source);
	await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent.includes("5 PDF pages"));
	await page.select('[role="dialog"] select', "extract"); await page.type('input[placeholder="3–8, 12"]', "2-3,5");
	await page.click(nameInput); await page.keyboard.down(modifier); await page.keyboard.press("KeyA"); await page.keyboard.up(modifier); await page.type(nameInput, "Custom extract");
	await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "Apply").click());
	await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Attach PDF pages"]'));
	assert.deepEqual(await fs.readdir(path.join(data, "pdf-extracts")), hashes, "picker reuses the shared content directory");
	assert.deepEqual(await fs.readdir(path.dirname(output)), ["Custom extract.pdf"]);
	draft = await page.$eval("[data-file-path-input]", element => element.textContent);
	await drop();
	await page.select('[role="dialog"] select', "extract"); await page.type('input[placeholder="3–8, 12"]', "1");
	await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(button => button.textContent === "Cancel").click());
	assert.equal(await page.$eval("[data-file-path-input]", element => element.textContent), draft);
	await page.waitForFunction(async () => { const response = await fetch("/api/chats"); return response.ok; });
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ passed: true, extractedPages: 3, pickerAndDrop: true, reusedSharedExtract: true, cancelledDraftUnchanged: true, screenshot: path.join(temp, "pdf-dialog.png"), data }, null, 2));
} catch (error) { console.error(error, logs); if (page) console.error(await page.evaluate(() => ({ text: document.body.innerText.slice(-5000), mains: [...document.querySelectorAll("main")].map(e => e.outerHTML.slice(0, 400)) }))); throw error; }
finally { if (process.platform === "win32") { try { execFileSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} } else server.kill(); browser?.process()?.kill(); }
