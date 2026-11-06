/** Offline browser smoke test against an explicitly supplied, disposable server.
 * node scripts/verify-session-notes.mjs http://localhost:3218
 * Organizer transport is mocked: this script NEVER purchases a model call. */
import assert from "node:assert/strict";
import puppeteer from "puppeteer-core";

const base = process.argv[2];
if (!base) throw new Error("Supply the URL of a disposable LearnHarness server (isolated LH_DATA_DIR).");
const executablePath = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
async function api(route, method = "GET", body) {
	const response = await fetch(`${base}${route}`, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
	assert.ok(response.ok, `${method} ${route}: ${response.status}`);
	return response.json();
}
const suffix = Date.now();
const first = await api("/api/chats", "POST", { title: `Browser notes smoke ${suffix}` });
const second = await api("/api/chats", "POST", { title: `Browser notes second ${suffix}`, kind: "practice" });
console.log("Launching browser against disposable sessions", first.id, second.id);
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.setDefaultTimeout(15_000);
page.setDefaultNavigationTimeout(15_000);
await page.setViewport({ width: 1440, height: 1000 });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
let modelCalls = 0;
let holdGeneration = false;
let heldRequest;
let failSave = false;
let holdApply = false;
let heldApply;
let applyAccepted;
const proposal = "# Organized\n\nUncertain why $x^2$ changes.\n\n## Formula reference\n\n$$\n\\int x\\,dx\n$$";
function respond(request) {
	const { revision } = JSON.parse(request.postData());
	return request.respond({ status: 200, contentType: "application/x-ndjson", body: [
		{ type: "start", proposalId: `browser-proposal-${modelCalls}`, baseRevision: revision, model: "fixture:cheap" },
		{ type: "text", text: proposal }, { type: "done", text: proposal },
	].map((value) => JSON.stringify(value)).join("\n") + "\n" });
}
await page.setRequestInterception(true);
page.on("request", (request) => {
	if (request.url().endsWith("/notes/organize")) {
		modelCalls++;
		if (holdGeneration) heldRequest = request;
		else void respond(request);
	} else if (holdApply && request.method() === "PUT" && request.url().endsWith("/notes")) { heldApply = request; applyAccepted?.(); }
	else if (failSave && request.method() === "PUT" && request.url().endsWith("/notes")) void request.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Simulated save failure" }) });
	else void request.continue();
});
async function clickText(text, root = "body") {
	const button = await page.evaluateHandle((label, selector) => [...document.querySelector(selector).querySelectorAll("button")].find((node) => node.textContent.trim() === label), text, root);
	assert.ok(button.asElement(), `Missing button: ${text}`); await button.asElement().click(); await button.dispose();
}
const editor = '[data-testid="notes-editor-input"]';
const editorText = () => page.$$eval(`${editor} .cm-line`, (nodes) => nodes.map((node) => node.textContent).join("\n"));
const path = `/api/chats/${first.id}/notes`;
const original = "# Notes\n\nUncertain why $x^2$ changes.\n\n$$\n\\int x\\,dx\n$$";
async function waitSaved(markdown, chatId = first.id) {
	await page.waitForFunction(async (id, expected) => { const result = await (await fetch(`/api/chats/${id}/notes`)).json(); return result.markdown === expected; }, {}, chatId, markdown);
}
try {
	await page.goto(`${base}/chat/${first.id}`, { waitUntil: "domcontentloaded" });
	console.log("Checking typing and preview");
	await page.click('[data-testid="open-notes"]'); await page.waitForSelector(editor);
	await page.type(editor, original);
	await waitSaved(original);
	assert.equal(modelCalls, 0);
	await clickText("Preview", '[data-testid="notes-panel"]');
	await page.waitForSelector('[data-testid="notes-panel"] annotation[encoding="application/x-tex"]');
	assert.deepEqual(await page.$$eval('[data-testid="notes-panel"] annotation', (nodes) => nodes.map((node) => node.textContent)), ["x^2", "\\int x\\,dx"]);
	await page.click('[data-testid="open-side-chat"]'); await page.waitForSelector('[data-testid="side-chat-panel"]');
	assert.equal(await page.$('[data-testid="notes-panel"]'), null);
	await page.click('[data-testid="open-notes"]'); await clickText("Write", '[data-testid="notes-panel"]');
	assert.equal(await editorText(), original);

	await page.click('[data-testid="notes-organize"]'); await page.waitForSelector('[data-testid="notes-apply"]:not([disabled])');
	console.log("Checking Apply and undo");
	assert.equal((await api(path)).markdown, original);
	holdApply = true;
	const applying = new Promise((resolve) => { applyAccepted = resolve; });
	await page.click('[data-testid="notes-apply"]'); await applying;
	await page.click('[data-testid="open-side-chat"]');
	assert.equal(await page.$('[data-testid="notes-panel"]'), null);
	holdApply = false; await heldApply.continue(); await waitSaved(proposal);
	await page.click('[data-testid="open-notes"]');
	await page.waitForSelector(`${editor}[contenteditable="true"]`);
	await page.focus(editor); await page.keyboard.down("Control"); await page.keyboard.press("z"); await page.keyboard.up("Control");
	await waitSaved(original);
	assert.equal(modelCalls, 1);

	holdGeneration = true;
	console.log("Checking stale proposals and conflicts");
	await page.click('[data-testid="notes-organize"]');
	await page.waitForFunction(() => document.querySelector('[data-testid="note-organizer"]') !== null);
	await clickText("Write", '[data-testid="notes-panel"]'); await page.focus(editor); await page.keyboard.press("End"); await page.keyboard.type(" local edit");
	assert.ok(heldRequest, "Organizer POST was held"); await respond(heldRequest); holdGeneration = false;
	await clickText("Proposal", '[data-testid="notes-panel"]');
	await page.waitForSelector('[data-testid="notes-apply"][disabled]');
	assert.match(await page.$eval('[data-testid="note-organizer"]', (node) => node.textContent), /Your notes changed/);
	await clickText("Discard", '[data-testid="note-organizer"]');
	await page.waitForFunction(async (id) => (await (await fetch(`/api/chats/${id}/notes`)).json()).markdown.includes("local edit"), {}, first.id);

	// Two-window conflict simulation through the canonical endpoint, while
	// local edits remain in the debounce window.
	await page.focus(editor); await page.keyboard.type(" unsaved conflict");
	const canonical = await api(path);
	await api(path, "PUT", { markdown: "external server version", expectedRevision: canonical.revision });
	await page.waitForFunction(() => document.querySelector('[data-testid="notes-panel"]').textContent.includes("Autosave is paused"));
	assert.match(await editorText(), /unsaved conflict/);
	await clickText("Keep server version", '[data-testid="notes-panel"]');
	assert.equal(await editorText(), "external server version");

	failSave = true; await page.focus(editor); await page.keyboard.type(" unsaved navigation");
	console.log("Checking guarded navigation and reload");
	await page.click('[data-testid="new-session"]');
	await page.waitForSelector('[role="alertdialog"][aria-label="Notes could not be saved"]');
	assert.equal(new URL(page.url()).pathname, `/chat/${first.id}`);
	await clickText("Stay and open Notes");
	failSave = false;
	await clickText("Retry", '[data-testid="notes-panel"]');
	await page.waitForFunction(() => !document.querySelector('[data-testid="notes-panel"]').textContent.includes("Unsaved"));
	await page.click('[data-testid="new-session"]'); await page.waitForFunction(() => location.pathname === "/chat/new");
	await page.goBack(); await page.waitForFunction((id) => location.pathname === `/chat/${id}`, {}, first.id);
	await page.click('[data-testid="open-notes"]'); await page.waitForSelector(editor);
	assert.match(await editorText(), /unsaved navigation/);
	// Back/forward must guard the current session, not the destination URL.
	await page.click('[data-testid="kind-filter-all"]');
	const secondRow = await page.evaluateHandle((title) => [...document.querySelectorAll('[data-testid="session-row"]')].find((row) => row.textContent.includes(title)), second.title);
	await secondRow.asElement().click(); await secondRow.dispose();
	await page.waitForFunction((id) => location.pathname === `/chat/${id}`, {}, second.id);
	await page.click('[data-testid="open-notes"]'); await page.waitForSelector(editor);
	failSave = true; await page.type(editor, "unsaved before Back");
	await page.evaluate(() => history.back());
	await page.waitForSelector('[role="alertdialog"][aria-label="Notes could not be saved"]');
	assert.equal(new URL(page.url()).pathname, `/chat/${second.id}`);
	await clickText("Leave without saving"); failSave = false;
	await page.waitForFunction((id) => location.pathname === `/chat/${id}`, {}, first.id);

	await page.reload({ waitUntil: "domcontentloaded" }); await page.click('[data-testid="open-notes"]'); await page.waitForSelector(editor);
	assert.match(await editorText(), /unsaved navigation/);
	await page.setViewport({ width: 700, height: 900 });
	await page.waitForSelector('[data-testid="notes-panel"][data-layout="overlay"]');
	await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector('[data-testid="notes-panel"]'));
	await page.goto(`${base}/chat/${second.id}`, { waitUntil: "domcontentloaded" }); await page.click('[data-testid="open-notes"]'); await page.waitForSelector(editor);
	assert.equal(await editorText(), "");
	if (process.argv[3]) {
		const fixtureId = process.argv[3];
		console.log("Checking settled teacher selection and TeX insertion");
		await page.setViewport({ width: 1440, height: 1000 });
		await page.goto(`${base}/chat/${fixtureId}`, { waitUntil: "domcontentloaded" });
		await page.waitForSelector('[data-side-chat-source] .katex');
		// Use actual selectable content, never a range crossing the existing
		// equation-copy control (the shared selection guard rejects controls).
		for (const [selector, selectedText] of [
			['[data-side-chat-source] p:first-child', "The derivative"],
			['[data-side-chat-source] .katex-display .katex', "\\int"],
			['[data-side-chat-source] p:last-child', "literal"],
		]) {
			await page.evaluate((selector) => {
				const content = document.querySelector(selector);
				const range = document.createRange(); range.selectNodeContents(content);
				const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
			}, selector);
			await page.waitForSelector('[data-side-selection-toolbar]');
			await clickText("Add to notes", '[data-side-selection-toolbar]');
			await page.waitForSelector(editor);
			await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "notes-editor-input");
			assert((await page.evaluate(() => window.getSelection()?.toString() ?? "")).includes(selectedText), "Inserted text remains selected in Notes");
		}
		await page.waitForFunction(async (id) => (await (await fetch(`/api/chats/${id}/notes`)).json()).markdown.includes("money"), {}, fixtureId);
		const quoted = await api(`/api/chats/${fixtureId}/notes`);
		assert.match(quoted.markdown, /> .*\$x\^2\$/);
		assert.match(quoted.markdown, /> \\int x\\,dx/);
		assert.match(quoted.markdown, /\\\*\\\*literal\\\*\\\* \\\$money\\\$/);
		await clickText("Preview", '[data-testid="notes-panel"]');
		await page.waitForSelector('[data-testid="notes-panel"] .katex-display');
		assert.equal(await page.$$eval('[data-testid="notes-panel"] annotation[encoding="application/x-tex"]', (nodes) => nodes.length), 3);
		assert.equal(modelCalls, 2, "teacher selection is model-free");
	}
	assert.deepEqual(errors, []);
	console.log(JSON.stringify({ ok: true, checks: ["CodeMirror typing", "autosave", "KaTeX preview", "panel switching", "preview-before-Apply", "Apply undo", "dirty proposal invalidation", "conflict preservation", "failed navigation flush", "reload persistence", "responsive overlay", "Escape", "practice notes", ...(process.argv[3] ? ["teacher selection", "inline/display TeX", "literal quote characters", "insertion focus"] : [])], mockedOrganizerCalls: modelCalls }));
} catch (error) {
	console.error("Browser verification failed:", error);
	throw error;
} finally {
	const timeout = setTimeout(() => browser.process()?.kill(), 5_000);
	try { await browser.close(); } finally { clearTimeout(timeout); }
}
